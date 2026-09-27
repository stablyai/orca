import { z } from 'zod'
import {
  assertConnectionRouteActive,
  ConnectionRouteError,
  ConnectionRouteSchema,
  type ConnectionRoute,
  type ConnectionRouteProvider
} from './connection-route'
import { readSshRouteCredentials } from './ssh-route-credentials'
import { sshRouteError, sshTunnelModule } from './ssh-route-native'

const SshOpenResultSchema = z.object({
  endpoint: z.string(),
  stages: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional()
    .default([]),
  error: z.string().optional()
})

export function createSshConnectionRoute(route: ConnectionRoute): ConnectionRouteProvider {
  const config = ConnectionRouteSchema.parse(route)
  return {
    async open(endpoint, signal) {
      // TLS hostname validation cannot use the temporary phone-loopback name.
      if (new URL(endpoint).protocol !== 'ws:') {
        throw new ConnectionRouteError(
          'SSH forwarding requires the Orca server’s ws:// endpoint; WSS endpoints are not supported by this route yet.',
          false
        )
      }
      let credentials
      let jumpCredentials
      try {
        credentials = await readSshRouteCredentials(config.credentialId)
        jumpCredentials = config.jump
          ? await readSshRouteCredentials(config.jump.credentialId)
          : undefined
      } catch {
        throw new ConnectionRouteError(
          'SSH credentials are unavailable. Unlock your device or edit the SSH connection.',
          false
        )
      }
      assertConnectionRouteActive(signal)
      const module = await sshTunnelModule()
      assertConnectionRouteActive(signal)
      const id = module.create()
      let closed = false
      const close = () => {
        if (closed) {
          return
        }
        closed = true
        signal.removeEventListener('abort', close)
        module.close(id)
      }
      signal.addEventListener('abort', close, { once: true })
      try {
        assertConnectionRouteActive(signal)
        const raw = await module.open(
          id,
          JSON.stringify({
            host: config.host,
            port: config.port,
            username: config.username,
            targetHost: config.targetHost,
            targetPort: config.targetPort,
            hostKeyFingerprint: config.hostKeyFingerprint,
            ...(credentials.kind === 'password'
              ? { password: credentials.password }
              : { privateKey: credentials.privateKey, passphrase: credentials.passphrase }),
            ...(config.jump
              ? {
                  jump: {
                    host: config.jump.host,
                    port: config.jump.port,
                    username: config.jump.username,
                    hostKeyFingerprint: config.jump.hostKeyFingerprint,
                    ...(jumpCredentials === undefined
                      ? {}
                      : jumpCredentials.kind === 'password'
                        ? { password: jumpCredentials.password }
                        : {
                            privateKey: jumpCredentials.privateKey,
                            passphrase: jumpCredentials.passphrase
                          })
                  }
                }
              : {})
          })
        )
        assertConnectionRouteActive(signal)
        const result = SshOpenResultSchema.parse(JSON.parse(raw))
        if (result.error) {
          throw sshRouteError(new Error(result.error), result.stages)
        }
        if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(result.endpoint)) {
          throw new Error('Invalid native endpoint')
        }
        return { endpoint: result.endpoint, stages: result.stages, close }
      } catch (error) {
        close()
        // Why: re-classifying an already-classified failure drops its code, its
        // retryable flag (host-key mismatch must never retry) and its stages.
        throw error instanceof ConnectionRouteError ? error : sshRouteError(error)
      }
    }
  }
}
