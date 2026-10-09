import { Server, utils, type AuthenticationType, type Connection } from 'ssh2'

export const WIRE_PASSWORD = 'fixture-password'
export const WIRE_PASSPHRASE = 'fixture-passphrase'

export type CredentialServerOptions = {
  methods?: AuthenticationType[]
  password?: string
  acceptedKey?: Buffer
  secondFactor?: 'password' | 'keyboard-interactive'
  hostKey?: string
}

export async function startCredentialServer(options: CredentialServerOptions = {}): Promise<{
  port: number
  attempts: string[][]
  close: () => Promise<void>
}> {
  const connections = new Set<Connection>()
  const attempts: string[][] = []
  const server = new Server(
    { hostKeys: [options.hostKey ?? utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (connection) => {
      connections.add(connection)
      connection.on('error', () => {})
      connection.on('close', () => connections.delete(connection))
      const methods: string[] = []
      attempts.push(methods)
      let keyAccepted = false
      connection.on('authentication', (context) => {
        methods.push(context.method)
        const offered =
          keyAccepted && options.secondFactor
            ? [options.secondFactor]
            : (options.methods ?? ['publickey', 'password'])
        if (context.method === 'publickey' && options.acceptedKey?.equals(context.key.data)) {
          if (!context.signature) {
            context.accept()
          } else if (options.secondFactor) {
            keyAccepted = true
            context.reject([options.secondFactor], true)
          } else {
            context.accept()
          }
        } else if (
          context.method === 'password' &&
          context.password === (options.password ?? WIRE_PASSWORD) &&
          (!options.secondFactor || keyAccepted)
        ) {
          context.accept()
        } else if (
          context.method === 'keyboard-interactive' &&
          keyAccepted &&
          options.secondFactor === 'keyboard-interactive'
        ) {
          context.prompt([{ prompt: 'Verification code:', echo: false }], 'MFA', '', (answers) => {
            if (answers[0] === '123456') {
              context.accept()
            } else {
              context.reject(offered)
            }
          })
        } else {
          context.reject(offered)
        }
      })
    }
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('SSH fixture did not bind')
  }
  return {
    port: address.port,
    attempts,
    close: async () => {
      for (const connection of connections) {
        connection.end()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

export function makeCredentialKey(passphrase?: string): { privateKey: string; publicKey: Buffer } {
  const pair = utils.generateKeyPairSync('ecdsa', {
    bits: 256,
    ...(passphrase ? { passphrase, cipher: 'aes256-cbc' } : {})
  })
  const parsed = utils.parseKey(pair.private, passphrase)
  if (parsed instanceof Error || Array.isArray(parsed)) {
    throw new Error('Fixture key did not parse')
  }
  return { privateKey: pair.private, publicKey: parsed.getPublicSSH() }
}
