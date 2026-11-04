import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginService } from './plugin-service'
import { getUserPluginsDir } from './plugin-discovery'
import { installPluginFromLocalPath } from './installation/plugin-install'
import type { PluginRuntimeDelegate } from './workers/plugin-host-service-bindings'
import type { PluginDesktopFrameServices } from './workers/plugin-host-method-bindings'
import { executePluginHostCall } from './workers/plugin-host-methods'
import type { PluginKillListEntry } from '../../shared/plugins/catalog/plugin-kill-list'

vi.mock('electron', () => ({ ipcMain: { handle() {}, on() {} } }))

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0)) {
    await step()
  }
})

function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

/** A save whose dialog stays open until `dialog.open()`, then writes only if still active. */
async function createSavingPlugin() {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-revocation-'))
  const settings: { disabled: string[]; consents: Record<string, string> } = {
    disabled: [],
    consents: {}
  }
  let killed: PluginKillListEntry | null = null
  const dialog = gate()
  const writes: string[] = []
  const desktop: PluginDesktopFrameServices = {
    openExternal: async () => ({ opened: true }),
    async saveFile(pluginId, _input, scope) {
      await dialog.opened
      scope.assertActive()
      writes.push(pluginId)
      return true
    }
  }
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => settings.disabled,
    getPluginConsents: () => settings.consents,
    getDevPluginPaths: () => [],
    getPluginKillListEntry: () => killed,
    getDesktopFrameServices: () => desktop,
    hostEntryPath: 'inert-worker-entry'
  })
  cleanup.push(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.saveAs reaches only the desktop sink, never the runtime delegate.
  service.setRuntimeDelegate({} as PluginRuntimeDelegate)
  await service.initialize()
  const source = join(root, 'source')
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'saver',
      publisher: 'revocation',
      name: 'saver',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }] },
      capabilities: []
    })
  )
  await writeFile(join(source, 'panel.html'), '<p>panel</p>')
  const installed = await installPluginFromLocalPath({
    pluginsDir: getUserPluginsDir(root),
    sourcePath: source,
    hostVersion: '1.4.0'
  })
  if (!installed.ok) {
    throw new Error(installed.error)
  }
  const key = installed.pluginKey
  settings.consents[key] = installed.consentFingerprint
  await service.refresh()
  const save = () =>
    service.executeHostCall(key, 'files.saveAs', { data: 'x' }, 'panel', { webContentsId: 1 })
  return {
    service,
    key,
    settings,
    dialog,
    writes,
    save,
    kill: (reason: string) => (killed = { pluginKey: key, reason })
  }
}

describe('revocation during an admitted call', () => {
  it('writes when the plugin stays approved', async () => {
    const { dialog, writes, save, key } = await createSavingPlugin()
    const pending = save()
    dialog.open()
    await expect(pending).resolves.toEqual({ ok: true, value: { status: 'saved' } })
    expect(writes).toEqual([key])
  })

  it('writes nothing once the plugin is disabled while the dialog is open', async () => {
    const { dialog, writes, save, settings, key } = await createSavingPlugin()
    const pending = save()
    settings.disabled.push(key)
    dialog.open()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'consent_required' })
    expect(writes).toEqual([])
  })

  it('writes nothing once the plugin is kill-listed while the dialog is open', async () => {
    const { dialog, writes, save, kill } = await createSavingPlugin()
    const pending = save()
    kill('compromised')
    dialog.open()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'consent_required' })
    expect(writes).toEqual([])
  })

  it('writes nothing, and grants nothing, while the plugin is being uninstalled', async () => {
    const { service, dialog, writes, save, key } = await createSavingPlugin()
    const pending = save()
    const removing = gate()
    const entered = gate()
    const removal = service.removePlugin(key, async () => {
      entered.open()
      await removing.opened
    })
    await entered.opened
    expect(service.getGrantedCapabilities(key)).toBeNull()
    dialog.open()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'consent_required' })
    expect(writes).toEqual([])
    removing.open()
    await removal
  })
})

describe('revocation checks inside executePluginHostCall', () => {
  it('re-checks after the audit write and before terminal input', async () => {
    let active = true
    const scope = {
      assertActive: () => {
        if (!active) {
          throw Object.assign(new Error('revoked'), { code: 'consent_required' })
        }
      }
    }
    const sendTerminalText = vi.fn().mockResolvedValue({ accepted: true })
    const services = {
      resolveActiveWorktreeContext: async () => ({
        worktreeId: 'w',
        branch: 'main',
        displayName: 'w'
      }),
      listWorktreeTerminals: async () => {
        active = false
        return [{ id: 't1' }]
      },
      sendTerminalText,
      listAgentStatuses: () => [],
      dispatchPluginNotification: vi.fn(),
      storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn() },
      secrets: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), protection: vi.fn() },
      settings: { getAll: vi.fn(), set: vi.fn() }
    }
    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'terminal.sendText',
      params: { terminalId: 't1', text: 'rm -rf ~', enter: true },
      surface: 'worker',
      grantedCapabilities: ['terminal:send'],
      services,
      audit: { record: vi.fn().mockResolvedValue(undefined) },
      scope
    })
    expect(outcome).toMatchObject({ ok: false })
    expect(sendTerminalText).not.toHaveBeenCalled()

    const storageSet = vi.fn().mockReturnValue({ ok: true })
    active = true
    const revokedDuringAudit = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'storage.set',
      params: { key: 'k', value: 1 },
      surface: 'worker',
      grantedCapabilities: ['storage:own'],
      services: { ...services, storage: { ...services.storage, set: storageSet } },
      audit: {
        record: vi.fn(async () => {
          active = false
        })
      },
      scope
    })
    expect(revokedDuringAudit).toMatchObject({ ok: false })
    expect(storageSet).not.toHaveBeenCalled()
  })
})
