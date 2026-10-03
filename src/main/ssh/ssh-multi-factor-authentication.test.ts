import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BaseAgent,
  Client,
  Server as Ssh2Server,
  utils,
  type AuthContext,
  type Connection,
  type IdentityCallback,
  type KeyboardAuthContext,
  type ParsedKey,
  type PasswordAuthContext,
  type SignCallback,
  type SigningRequestOptions
} from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import { buildConnectConfig, type BuildConnectConfigOptions } from './ssh-connection-utils'

// OpenSSH's default; a host that burns it disconnects before the MFA stage is reached.
const MAX_AUTH_TRIES = 6
const PASSWORD = 'stage-one-password'
const PASSCODE = '123456'

type AuthStage = 'password' | 'keyboard-interactive' | 'publickey'

function generatePrivateKey(): string {
  return utils.generateKeyPairSync('ecdsa', { bits: 256 }).private
}

function parseFixtureKey(privateKey: string): ParsedKey {
  const key = utils.parseKey(privateKey)
  if (key instanceof Error || Array.isArray(key)) {
    throw new Error('fixture key did not parse to a single key')
  }
  return key
}

/** An ssh-agent stand-in holding one key, so the agent rung can satisfy a publickey stage. */
class SingleKeyAgent extends BaseAgent<ParsedKey> {
  private readonly key = parseFixtureKey(generatePrivateKey())

  getIdentities(callback: IdentityCallback<ParsedKey>): void {
    callback(undefined, [this.key])
  }

  sign(
    _pubKey: ParsedKey,
    data: Buffer,
    optionsOrCallback?: SigningRequestOptions | SignCallback,
    callback?: SignCallback
  ): void {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
    const signature = this.key.sign(data, options?.hash)
    if (signature instanceof Error) {
      done?.(signature)
      return
    }
    done?.(undefined, signature)
  }
}

type MfaServer = {
  port: number
  attempts: string[]
  close: () => Promise<void>
}

/**
 * An OpenSSH-style `AuthenticationMethods a,b` host: each stage partial-succeeds into the next.
 * A stage given as a list accepts any of its methods; `authorizedKey` limits publickey to one key.
 */
async function startMultiFactorServer(
  stages: (AuthStage | AuthStage[])[],
  authorizedKey?: ParsedKey
): Promise<MfaServer> {
  const attempts: string[] = []
  const connections = new Set<Connection>()
  // Ed25519 keygen can produce an invalid 31-byte key; ECDSA points always start with 0x04.
  const hostKey = utils.generateKeyPairSync('ecdsa', { bits: 256 }).private
  const server = new Ssh2Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection)
    connection.on('error', () => {})
    connection.on('close', () => connections.delete(connection))
    let stage = 0
    let failures = 0
    const remaining = (): AuthStage[] => [stages[stage]!].flat()
    const fail = (context: AuthContext): void => {
      failures += 1
      if (failures >= MAX_AUTH_TRIES) {
        connection.end()
        return
      }
      context.reject(remaining(), false)
    }
    connection.on('authentication', (context) => {
      attempts.push(context.method)
      if (context.method === 'none') {
        context.reject(remaining(), false)
        return
      }
      if (!remaining().some((method) => method === context.method)) {
        fail(context)
        return
      }
      if (context.method === 'password') {
        if ((context as PasswordAuthContext).password !== PASSWORD) {
          fail(context)
          return
        }
        stage += 1
        if (stage === stages.length) {
          context.accept()
          return
        }
        context.reject(remaining(), true)
        return
      }
      if (context.method === 'publickey') {
        if (authorizedKey && !authorizedKey.getPublicSSH().equals(context.key.data)) {
          fail(context)
          return
        }
        // Query phase: claim the key is acceptable so the client sends the signature.
        if (!context.signature) {
          context.accept()
          return
        }
        stage += 1
        if (stage === stages.length) {
          context.accept()
          return
        }
        context.reject(remaining(), true)
        return
      }
      const keyboard = context as KeyboardAuthContext
      keyboard.prompt(
        [{ prompt: 'Duo passcode:', echo: false }],
        'Duo two-factor login',
        'Approve the push or enter a passcode.',
        (answers) => {
          if (answers?.[0] !== PASSCODE) {
            fail(context)
            return
          }
          stage += 1
          if (stage === stages.length) {
            context.accept()
            return
          }
          context.reject(remaining(), true)
        }
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('MFA fixture did not bind a TCP port')
  }
  return {
    port: address.port,
    attempts,
    close: async () => {
      for (const connection of connections) {
        connection.end()
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

function makeTarget(port: number, overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'mfa-target',
    label: 'hpc',
    source: 'manual',
    host: '127.0.0.1',
    port,
    username: 'fixture',
    ...overrides
  }
}

function makeResolved(port: number, identityFile: string[]): SshResolvedConfig {
  return {
    hostname: '127.0.0.1',
    port,
    user: 'fixture',
    identityFile,
    identitiesOnly: true,
    forwardAgent: false,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    userKnownHostsFiles: [],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask',
    hashKnownHosts: false,
    updateHostKeys: 'no'
  }
}

/** Drives ssh2 the way SshConnection does: one credential per keyboard-interactive prompt. */
function connectWithOrcaConfig(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  password: string | undefined,
  answers: string[],
  buildOptions: BuildConnectConfigOptions = { includeAgent: false, includePrivateKey: true },
  agent?: BaseAgent
): { ready: Promise<void>; prompts: string[] } {
  const prompts: string[] = []
  const config = buildConnectConfig(target, resolved, buildOptions)
  if (agent) {
    config.agent = agent
  }
  if (password != null) {
    config.password = password
  }
  const ready = new Promise<void>((resolve, reject) => {
    const client = new Client()
    let answerIndex = 0
    client.on('keyboard-interactive', (_name, _instructions, _lang, requested, finish) => {
      for (const requestedPrompt of requested) {
        prompts.push(requestedPrompt.prompt)
      }
      finish(requested.map(() => answers[answerIndex++] ?? ''))
    })
    client.once('ready', () => {
      client.end()
      resolve()
    })
    client.once('error', reject)
    client.once('close', () => reject(new Error('SSH connection closed during authentication')))
    client.connect({ ...config, hostVerifier: () => true, readyTimeout: 10_000 })
  })
  return { ready, prompts }
}

describe('multi-stage SSH authentication', () => {
  let tempDir: string
  let keyPaths: string[]
  let homeEnv: { HOME?: string; USERPROFILE?: string }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-mfa-'))
    // Why: the cases below pass `resolved: null`, so `resolvePrivateKeys` falls through to
    // `findDefaultKeyFile`, which reads `~/.ssh/id_*` through `homedir()`. On a developer
    // machine that picks up a real key, and an encrypted one makes ssh2 reject with
    // "Cannot parse privateKey" before authentication is exercised at all. Hosted CI has no
    // key, so this only ever failed locally. Pointing home at the fixture directory keeps
    // default-key discovery inside the test's control on every machine.
    homeEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = tempDir
    process.env.USERPROFILE = tempDir
    keyPaths = ['id_a', 'id_b'].map((name) => {
      const path = join(tempDir, name)
      writeFileSync(path, utils.generateKeyPairSync('ecdsa', { bits: 256 }).private)
      return path
    })
  })

  afterEach(() => {
    for (const key of ['HOME', 'USERPROFILE'] as const) {
      const previous = homeEnv[key]
      if (previous === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('answers a keyboard-interactive stage that follows a password partial success', async () => {
    const server = await startMultiFactorServer(['password', 'keyboard-interactive'])
    try {
      const { ready, prompts } = connectWithOrcaConfig(makeTarget(server.port), null, PASSWORD, [
        PASSCODE
      ])

      await expect(ready).resolves.toBeUndefined()
      expect(prompts).toEqual(['Duo passcode:'])
    } finally {
      await server.close()
    }
  })

  it('answers a second keyboard-interactive stage after the first partially succeeds', async () => {
    const server = await startMultiFactorServer(['keyboard-interactive', 'keyboard-interactive'])
    try {
      const { ready, prompts } = connectWithOrcaConfig(makeTarget(server.port), null, undefined, [
        PASSCODE,
        PASSCODE
      ])

      await expect(ready).resolves.toBeUndefined()
      expect(prompts).toEqual(['Duo passcode:', 'Duo passcode:'])
    } finally {
      await server.close()
    }
  })

  it('reaches the MFA stage without burning the host auth-try budget on rejected keys', async () => {
    const server = await startMultiFactorServer(['password', 'keyboard-interactive'])
    try {
      const target = makeTarget(server.port, { source: 'ssh-config', configHost: 'hpc' })
      const { ready } = connectWithOrcaConfig(
        target,
        makeResolved(server.port, keyPaths),
        PASSWORD,
        [PASSCODE]
      )

      await expect(ready).resolves.toBeUndefined()
      // After the password stage partially succeeds the host only offers keyboard-interactive;
      // re-offering keys there is what exhausts MaxAuthTries on real MFA hosts.
      expect(server.attempts.filter((method) => method === 'publickey')).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('keeps the challenge on the agent-first attempt when the waiting ~/.ssh key is encrypted', async () => {
    // Deferring here would only trade the password dialog for a passphrase one on the key retry.
    mkdirSync(join(tempDir, '.ssh'))
    writeFileSync(
      join(tempDir, '.ssh', 'id_ed25519'),
      utils.generateKeyPairSync('ecdsa', {
        bits: 256,
        passphrase: 'fixture-passphrase',
        cipher: 'aes256-ctr',
        rounds: 1
      }).private
    )
    const server = await startMultiFactorServer(
      [['publickey', 'keyboard-interactive']],
      parseFixtureKey(generatePrivateKey())
    )
    try {
      const { ready, prompts } = connectWithOrcaConfig(
        makeTarget(server.port, { identityAgent: join(tempDir, 'agent.sock') }),
        null,
        undefined,
        [PASSCODE],
        { includeAgent: true },
        new SingleKeyAgent()
      )

      await expect(ready).resolves.toBeUndefined()
      expect(prompts).toEqual(['Duo passcode:'])
    } finally {
      await server.close()
    }
  })

  describe('on the agent-first attempt, which defers ~/.ssh/id_ed25519 to the key retry', () => {
    let deferredKey: ParsedKey

    beforeEach(() => {
      const privateKey = generatePrivateKey()
      deferredKey = parseFixtureKey(privateKey)
      mkdirSync(join(tempDir, '.ssh'))
      writeFileSync(join(tempDir, '.ssh', 'id_ed25519'), privateKey)
    })

    it('holds a first-factor challenge back until the attempt that carries the deferred key', async () => {
      // A host taking either a key or a keyboard-interactive password, where only the deferred key
      // is authorized: a challenge on the agent-first attempt is a dialog the key makes unnecessary.
      const server = await startMultiFactorServer(
        [['publickey', 'keyboard-interactive']],
        deferredKey
      )
      try {
        const target = makeTarget(server.port, { identityAgent: join(tempDir, 'agent.sock') })
        const agentFirst = connectWithOrcaConfig(
          target,
          null,
          undefined,
          [PASSCODE],
          { includeAgent: true },
          new SingleKeyAgent()
        )
        await expect(agentFirst.ready).rejects.toThrow(
          'All configured authentication methods failed'
        )
        expect(agentFirst.prompts).toEqual([])

        const keyRetry = connectWithOrcaConfig(target, null, undefined, [PASSCODE])
        await expect(keyRetry.ready).resolves.toBeUndefined()
        expect(keyRetry.prompts).toEqual([])
      } finally {
        await server.close()
      }
    })

    it('answers the second factor after the agent key partially succeeds', async () => {
      const server = await startMultiFactorServer(['publickey', 'keyboard-interactive'])
      try {
        const { ready, prompts } = connectWithOrcaConfig(
          makeTarget(server.port, { identityAgent: join(tempDir, 'agent.sock') }),
          null,
          undefined,
          [PASSCODE],
          { includeAgent: true },
          new SingleKeyAgent()
        )

        await expect(ready).resolves.toBeUndefined()
        expect(prompts).toEqual(['Duo passcode:'])
      } finally {
        await server.close()
      }
    })
  })
})
