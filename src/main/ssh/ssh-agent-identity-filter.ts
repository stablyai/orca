import type {
  BaseAgent,
  IdentityCallback,
  ParsedKey,
  PublicKeyEntry,
  SignCallback,
  SigningRequestOptions
} from 'ssh2'
import { resolveSshConfigHomePath } from './config/ssh-config-path-expansion'
import { readSshIdentityFileSync } from './ssh-identity-file-read'
import { loadSsh2 } from './ssh2-module-load'

type AgentPublicKey = ParsedKey | Buffer | string | PublicKeyEntry

function comparablePublicKey(key: AgentPublicKey): ParsedKey | Buffer | string {
  if (typeof key === 'object' && 'pubKey' in key) {
    const pubKey = key.pubKey
    if (typeof pubKey === 'object' && 'pubKey' in pubKey) {
      return pubKey.pubKey
    }
    return pubKey
  }
  return key
}

// Define on first use: extending BaseAgent would otherwise load ssh2 at startup (#35731).
function defineIdentityFilteredAgent() {
  return class IdentityFilteredAgent extends loadSsh2().BaseAgent<ParsedKey | Buffer | string> {
    readonly kind = 'identity-filtered-agent'
    declare getStream?: BaseAgent['getStream']

    constructor(
      readonly socketPath: string,
      private readonly agent: BaseAgent,
      private readonly allowedKeys: ParsedKey[]
    ) {
      super()
      if (agent.getStream) {
        this.getStream = agent.getStream.bind(agent)
      }
    }

    getIdentities(callback: IdentityCallback): void {
      this.agent.getIdentities((error, keys) => {
        if (error) {
          callback(error)
          return
        }
        callback(
          undefined,
          keys?.filter((key) =>
            this.allowedKeys.some((allowedKey) => allowedKey.equals(comparablePublicKey(key)))
          ) ?? []
        )
      })
    }

    sign(
      pubKey: ParsedKey | Buffer | string,
      data: Buffer,
      optionsOrCallback?: SigningRequestOptions | SignCallback,
      callback?: SignCallback
    ): void {
      if (typeof optionsOrCallback === 'function') {
        this.agent.sign(pubKey, data, optionsOrCallback)
        return
      }
      this.agent.sign(pubKey, data, optionsOrCallback ?? {}, callback)
    }
  }
}

let IdentityFilteredAgent: ReturnType<typeof defineIdentityFilteredAgent> | null = null

function parseIdentityKeyFile(filePath: string): ParsedKey | undefined {
  const { contents } = readSshIdentityFileSync(filePath)
  if (!contents) {
    return undefined
  }
  const { utils } = loadSsh2()
  try {
    const parsed = utils.parseKey(contents) as ParsedKey | ParsedKey[] | Error
    if (parsed instanceof Error) {
      return undefined
    }
    return Array.isArray(parsed) ? parsed[0] : parsed
  } catch {
    return undefined
  }
}

function readIdentityKeys(paths: string[]): ParsedKey[] {
  const keys: ParsedKey[] = []
  for (const path of paths) {
    const identityPath = resolveSshConfigHomePath(path)
    const key = parseIdentityKeyFile(`${identityPath}.pub`) ?? parseIdentityKeyFile(identityPath)
    if (key) {
      keys.push(key)
    }
  }
  return keys
}

export function createIdentityFilteredAgent(
  agentSocket: string,
  identityFilePaths: string[]
): BaseAgent | undefined {
  const identityKeys = readIdentityKeys(identityFilePaths)
  if (identityKeys.length === 0) {
    return undefined
  }
  // ssh2 lacks IdentitiesOnly; expose only configured IdentityFile keys instead of every agent key.
  IdentityFilteredAgent ??= defineIdentityFilteredAgent()
  return new IdentityFilteredAgent(agentSocket, loadSsh2().createAgent(agentSocket), identityKeys)
}
