import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { FilesystemHostProcess } from './filesystem-host-process'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import { FilesystemHostReadAuthority } from './filesystem-host-read-authority'
import {
  configureFilesystemHostReadAuthority,
  setFilesystemHostReadClientForTests
} from './filesystem-host-read-client'
import { extractOAuthClientCredentials } from '../rate-limits/gemini-cli-oauth-extractor'

const fixture = fileURLToPath(
  new URL('__fixtures__/filesystem-host-hang-fixture.cjs', import.meta.url)
)
afterEach(() => setFilesystemHostReadClientForTests(null))
it.each(['deadline', 'stop'] as const)(
  'physically bounds parked delegated discovery on %s, preserves sibling progress and permits retry',
  async (mode) => {
    let launched = 0
    let ready = false
    const supervisor = new FilesystemHostSupervisor({
      entryPath: fixture,
      maximumChildren: 3,
      breakerRecoveryDelayMs: 1,
      startProcess: async (options) => {
        if (++launched === 1) {
          const child = await FilesystemHostProcess.start({
            ...options,
            readyTimeoutMs: 1000,
            exitDeadlineMs: 100,
            hardKillDelayMs: 10
          })
          ready = true
          return child
        }
        return {
          invoke: async (operation) =>
            operation.kind === 'discover-gemini-oauth'
              ? {
                  kind: 'discover-gemini-oauth',
                  credentials: { clientId: 'recovered', clientSecret: 'secret' }
                }
              : {
                  kind: 'read-snapshot-file',
                  contentsBase64: Buffer.from('sibling').toString('base64')
                },
          retire: async () => {
            options.onPhysicalExit?.()
            return true
          }
        }
      }
    })
    const authority = new FilesystemHostReadAuthority({
      entryPath: fixture,
      supervisor: {
        dispatch: (input) =>
          supervisor.dispatch({
            ...input,
            deadlineMs: input.operation.kind === 'discover-gemini-oauth' ? 250 : 1000
          }),
        publishFailureDomain: (input) => supervisor.publishFailureDomain(input),
        removeFailureDomain: (input) => supervisor.removeFailureDomain(input),
        dispose: () => supervisor.dispose()
      }
    })
    configureFilesystemHostReadAuthority(authority)
    const parked = extractOAuthClientCredentials()
    const failed = expect(parked).rejects.toThrow()
    await vi.waitFor(() => expect(ready).toBe(true))
    expect((await authority.readSnapshotFile('/healthy/auth.json', 'grok-auth')).toString()).toBe(
      'sibling'
    )
    if (mode === 'stop') {
      await authority.dispose()
    }
    await failed
    await vi.waitFor(() =>
      expect(supervisor.health().physicalChildren).toBeLessThanOrEqual(mode === 'stop' ? 0 : 1)
    )
    if (mode === 'deadline') {
      await vi.waitFor(async () =>
        expect(await extractOAuthClientCredentials()).toMatchObject({ clientId: 'recovered' })
      )
      await authority.dispose()
    }
  }
)
