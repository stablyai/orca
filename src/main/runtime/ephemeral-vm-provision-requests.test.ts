import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runEphemeralVmProvisionRequest } from './ephemeral-vm-provision-requests'

const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'orca-vm-request-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
it('deduplicates concurrent retries and replays a durable result without provisioning', async () => {
  const path = directory()
  const args = { provisionId: 'request-1', repoId: 'source' }
  let finish: (() => void) | undefined
  const run = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: true, runtimeId: 'vm-1' })
      })
  )
  const first = runEphemeralVmProvisionRequest(path, args, run)
  const retry = runEphemeralVmProvisionRequest(path, args, run)
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  finish?.()
  expect(await first).toEqual(await retry)
  expect(await runEphemeralVmProvisionRequest(path, args, run)).toEqual({
    ok: true,
    runtimeId: 'vm-1'
  })
  expect(run).toHaveBeenCalledOnce()
  const file = readdirSync(join(path, 'ephemeral-vm-provision-requests'))[0]
  if (process.platform !== 'win32') {
    expect(statSync(join(path, 'ephemeral-vm-provision-requests', file)).mode & 0o777).toBe(0o600)
  }
})
it('refuses id reuse with different arguments while pending and after completion', async () => {
  const path = directory()
  const args = { provisionId: 'same', repoId: 'first' }
  let finish: (() => void) | undefined
  const pending = runEphemeralVmProvisionRequest(
    path,
    args,
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: false })
      })
  )
  await vi.waitFor(() => expect(finish).toBeDefined())
  const changed = { ...args, repoId: 'different' }
  await expect(runEphemeralVmProvisionRequest(path, changed, vi.fn())).rejects.toThrow(
    'different arguments'
  )
  finish?.()
  await pending
  await expect(runEphemeralVmProvisionRequest(path, changed, vi.fn())).rejects.toThrow(
    'different arguments'
  )
})
it('does not restart provisioning after a server-side interruption', async () => {
  const path = directory()
  const args = { provisionId: 'interrupted' }
  await expect(
    runEphemeralVmProvisionRequest(path, args, async () => {
      throw new Error('host stopped')
    })
  ).rejects.toThrow('host stopped')
  const run = vi.fn()
  await expect(runEphemeralVmProvisionRequest(path, args, run)).rejects.toThrow(
    'interrupted on the server'
  )
  expect(run).not.toHaveBeenCalled()
})
