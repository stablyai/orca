import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  Server as Ssh2Server,
  utils,
  type AuthContext,
  type Connection,
  type KeyboardAuthContext,
  type PasswordAuthContext
} from 'ssh2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import { buildConnectConfig } from './ssh-connection-utils'

// OpenSSH's default; a host that burns it disconnects before the MFA stage is reached.
const MAX_AUTH_TRIES = 6
const PASSWORD = 'stage-one-password'
const PASSCODE = '123456'

type AuthStage = 'password' | 'keyboard-interactive'

type MfaServer = {
  port: number
  attempts: string[]
  close: () => Promise<void>
}

/** An OpenSSH-style `AuthenticationMethods a,b` host: each stage partial-succeeds into the next. */
async function startMultiFactorServer(stages: AuthStage[]): Promise<MfaServer> {
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
    const remaining = (): AuthStage[] => [stages[stage]!]
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
      if (context.method !== stages[stage]) {
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
  answers: string[]
): { ready: Promise<void>; prompts: string[] } {
  const prompts: string[] = []
  const config = buildConnectConfig(target, resolved, {
    includeAgent: false,
    includePrivateKey: true
  })
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-mfa-'))
    keyPaths = ['id_a', 'id_b'].map((name) => {
      const path = join(tempDir, name)
      writeFileSync(path, utils.generateKeyPairSync('ecdsa', { bits: 256 }).private)
      return path
    })
  })

  afterEach(() => {
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
})
