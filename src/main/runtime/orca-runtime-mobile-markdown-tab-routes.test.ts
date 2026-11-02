import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { hashMarkdownContent } from '../../shared/mobile-markdown-document'
import type { RuntimeMobileSessionMarkdownTab } from '../../shared/runtime-types'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY,
  FILE_WRITE_IF_UNCHANGED_METHOD
} from '../../shared/file-write-disk-precondition'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { OrchestrationError } from './orchestration/orchestration-error'
import { RpcDispatcher } from './rpc/dispatcher'
import { FILE_METHODS } from './rpc/methods/files'
import { SESSION_TAB_MARKDOWN_METHODS } from './rpc/methods/session-tab-markdown-methods'

// Authorization is out of scope; both runtimes use unregistered temporary workspaces.
vi.mock('./files/chat-scratch-file-root', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveRuntimeAuthorizedPath: async (path: string) => path
}))

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { TEST_REPO_ID, TEST_WORKTREE_ID, makeRuntimeStoreWithWorkspaceSession, store } =
  await import('./orca-runtime-test-fixtures.spec')

type Runtime = InstanceType<typeof OrcaRuntimeService>

let root = ''
let readme = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-markdown-tab-routes-'))
  readme = join(root, 'README.md')
  await writeFile(readme, '# Notes\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function sessionWithFile(filePath: string, relativePath: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      [TEST_WORKTREE_ID]: [
        { filePath, relativePath, worktreeId: TEST_WORKTREE_ID, language: 'markdown' }
      ]
    }
  }
}

function sessionWithReadme(externalSshTargetId?: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          filePath: readme,
          relativePath: 'README.md',
          worktreeId: TEST_WORKTREE_ID,
          language: 'markdown',
          runtimeEnvironmentId: null,
          ...(externalSshTargetId ? { externalSshTargetId } : {})
        }
      ]
    },
    activeTabTypeByWorktree: { [TEST_WORKTREE_ID]: 'editor' },
    activeFileIdByWorktree: { [TEST_WORKTREE_ID]: readme }
  }
}

async function runtimeOnHost(
  executionHostId: ExecutionHostId,
  session = sessionWithReadme()
): Promise<Runtime> {
  const harness = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(harness.runtimeStore)
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const target = await runtime.resolveRuntimeFileTarget(`id:${TEST_WORKTREE_ID}`)
  vi.spyOn(runtime, 'resolveRuntimeFileTarget').mockResolvedValue({
    ...target,
    worktree: { ...target.worktree, path: root },
    executionHostId
  })
  return runtime
}

const CURRENT_SERVER = [
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IDENTICAL_RUNTIME_CAPABILITY
]
// Pre-#30605 servers lack disk-check capability and files.writeIfUnchanged.
const PRE_DISK_CHECK_SERVER = [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
const PAIRING_REVISION = 7

async function desktopOnServer(
  serverHost: ExecutionHostId = 'local',
  capabilities: string[] = CURRENT_SERVER
) {
  const server = await runtimeOnHost(serverHost)
  const serverDispatch = new RpcDispatcher({
    runtime: server,
    methods: [...FILE_METHODS, ...SESSION_TAB_MARKDOWN_METHODS].filter(
      (method) =>
        method.name !== FILE_WRITE_IF_UNCHANGED_METHOD ||
        capabilities.includes(FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY)
    )
  })
  const serverCalls: string[] = []
  const pins: (number | undefined)[] = []
  const serverForwards = vi.spyOn(server, 'callOrchestrationWorkerServer')
  const desktop = await runtimeOnHost('runtime:env-a')
  const pairing = { revision: PAIRING_REVISION }
  vi.spyOn(desktop, 'resolveOrchestrationWorkerServer').mockImplementation(() => ({
    environmentId: 'env-a',
    name: 'env-a',
    peerFingerprint: 'peer',
    pairingRevision: pairing.revision
  }))
  const call = vi
    .spyOn(desktop, 'callOrchestrationWorkerServer')
    .mockImplementation(async (environmentId, method, params, _timeout, _envelope, internal) => {
      expect(environmentId).toBe('env-a')
      serverCalls.push(method)
      const pin = internal?.expectedEnvironmentPairingRevision
      pins.push(pin)
      // Match transport rejection of calls pinned before re-pairing.
      if (pin !== undefined && pin !== pairing.revision) {
        throw new OrchestrationError(
          'runtime_environment_changed',
          'Runtime environment pairing changed; refresh and try again'
        )
      }
      if (method === 'status.get') {
        return { runtimeId: 'server-runtime', capabilities }
      }
      const response = await serverDispatch.dispatch({
        id: `call-${serverCalls.length}`,
        authToken: 'tok',
        method,
        params
      })
      if (!response.ok) {
        throw new OrchestrationError(response.error.code, response.error.message)
      }
      return response.result
    })
  return { desktop, call, serverCalls, serverForwards, pins, pairing }
}

describe("a phone's Markdown tab on a paired server's workspace", () => {
  it('reads the file on that server, which answers from its own disk', async () => {
    const { desktop, serverCalls, serverForwards } = await desktopOnServer()

    await expect(
      desktop.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, readme)
    ).resolves.toMatchObject({
      tabId: readme,
      content: '# Notes\n',
      version: hashMarkdownContent('# Notes\n'),
      isDirty: false,
      editable: true
    })
    expect(serverCalls).toEqual(['files.read'])
    expect(serverForwards).not.toHaveBeenCalled()
  })

  it('never hops on from a server that does not run the workspace itself', async () => {
    const { desktop, serverCalls, serverForwards } = await desktopOnServer('runtime:env-b')

    await expect(desktop.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, readme)).rejects.toThrow(
      'runtime:env-b is not dispatched by this process'
    )
    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).rejects.toThrow()
    expect(serverCalls).toEqual(['files.read', 'files.read'])
    expect(serverForwards).not.toHaveBeenCalled()
    expect(await readFile(readme, 'utf8')).toBe('# Notes\n')
  })

  it('saves through the server, which checks the precondition and writes', async () => {
    const { desktop, serverCalls, serverForwards, pins } = await desktopOnServer()

    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).resolves.toMatchObject({ content: '# Phone\n', isDirty: false })
    expect(await readFile(readme, 'utf8')).toBe('# Phone\n')
    expect(serverCalls).toEqual(['files.read', 'status.get', 'files.writeIfUnchanged'])
    expect(pins).toEqual([PAIRING_REVISION, PAIRING_REVISION, PAIRING_REVISION])
    expect(serverForwards).not.toHaveBeenCalled()
  })

  it("refuses a save the server's disk moved under", async () => {
    const { desktop, call } = await desktopOnServer()
    const forward = call.getMockImplementation()!
    call.mockImplementation(async (environmentId, method, params) => {
      if (method === 'files.writeIfUnchanged') {
        await writeFile(readme, '# Changed on the server\n')
      }
      return forward(environmentId, method, params)
    })

    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).rejects.toThrow('conflict')
    expect(await readFile(readme, 'utf8')).toBe('# Changed on the server\n')
  })

  it('saves an unchanged file on a server too old to check the disk, comparing here first', async () => {
    const { desktop, serverCalls, pins } = await desktopOnServer('local', PRE_DISK_CHECK_SERVER)

    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).resolves.toMatchObject({ content: '# Phone\n', isDirty: false })
    expect(await readFile(readme, 'utf8')).toBe('# Phone\n')
    expect(serverCalls).toEqual(['files.read', 'status.get', 'files.read', 'files.write'])
    expect(pins).toEqual([PAIRING_REVISION, PAIRING_REVISION, PAIRING_REVISION, PAIRING_REVISION])
  })

  it('refuses a changed file on a server too old to check the disk, and never writes', async () => {
    const { desktop, call, serverCalls } = await desktopOnServer('local', PRE_DISK_CHECK_SERVER)
    const forward = call.getMockImplementation()!
    call.mockImplementation(async (environmentId, method, params, ...rest) => {
      if (method === 'status.get') {
        await writeFile(readme, '# Changed on the server\n')
      }
      return forward(environmentId, method, params, ...rest)
    })

    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).rejects.toThrow('conflict')
    expect(serverCalls).not.toContain('files.write')
    expect(serverCalls).not.toContain(FILE_WRITE_IF_UNCHANGED_METHOD)
    expect(await readFile(readme, 'utf8')).toBe('# Changed on the server\n')
  })

  it('saves on a server too old to check the disk when its changed disk already holds the text', async () => {
    const { desktop, call, serverCalls } = await desktopOnServer('local', PRE_DISK_CHECK_SERVER)
    const forward = call.getMockImplementation()!
    call.mockImplementation(async (environmentId, method, params, ...rest) => {
      if (method === 'status.get') {
        await writeFile(readme, '# Phone\n')
      }
      return forward(environmentId, method, params, ...rest)
    })

    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).resolves.toMatchObject({ content: '# Phone\n', isDirty: false })
    expect(serverCalls).toEqual(['files.read', 'status.get', 'files.read'])
  })

  it('sends a phone save straight to a v1 server guard, without reading first', async () => {
    const { desktop, serverCalls } = await desktopOnServer('local', [
      FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
      FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY
    ])
    await desktop.saveMobileMarkdownTab(
      `id:${TEST_WORKTREE_ID}`,
      readme,
      hashMarkdownContent('# Notes\n'),
      '# Phone\n'
    )
    expect(serverCalls).toEqual(['files.read', 'status.get', 'files.writeIfUnchanged'])
    expect(await readFile(readme, 'utf8')).toBe('# Phone\n')
  })

  it('refuses a save whose server was re-paired after its first read, writing nothing', async () => {
    const { desktop, call, serverCalls, pairing } = await desktopOnServer()
    const forward = call.getMockImplementation()!
    call.mockImplementation(async (environmentId, method, params, ...rest) => {
      const answer = await forward(environmentId, method, params, ...rest)
      if (method === 'files.read') {
        pairing.revision = PAIRING_REVISION + 1
      }
      return answer
    })

    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).rejects.toThrow('pairing changed')
    expect(serverCalls).not.toContain(FILE_WRITE_IF_UNCHANGED_METHOD)
    expect(await readFile(readme, 'utf8')).toBe('# Notes\n')
  })

  it('reports a lost server as unavailable, never as a missing or empty file', async () => {
    const { desktop, call } = await desktopOnServer()
    call.mockRejectedValue(new Error('socket closed'))

    const read = desktop.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, readme)
    await expect(read).rejects.toBeInstanceOf(RemoteRuntimeClientError)
    await expect(read).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    expect(await readFile(readme, 'utf8')).toBe('# Notes\n')
  })
})

function moveWorkspaceAfterFirstLookup(runtime: Runtime, to: ExecutionHostId): void {
  const resolve = vi.mocked(runtime.resolveRuntimeFileTarget)
  const before = resolve.getMockImplementation()!
  resolve.mockImplementation(async (selector) => {
    const target = await before(selector)
    return resolve.mock.calls.length > 1 ? { ...target, executionHostId: to } : target
  })
}

describe("a phone's Markdown save whose workspace moves host mid-save", () => {
  it('still writes on the server it started on, pinned, never on local disk', async () => {
    const { desktop, call, serverCalls, pins } = await desktopOnServer()
    const forward = call.getMockImplementation()!
    // Server stub never touches shared temp disk; any disk change exposes a local write.
    call.mockImplementation(async (environmentId, method, params, timeout, envelope, internal) => {
      if (method !== FILE_WRITE_IF_UNCHANGED_METHOD) {
        return forward(environmentId, method, params, timeout, envelope, internal)
      }
      serverCalls.push(method)
      pins.push(internal?.expectedEnvironmentPairingRevision)
      return { ok: true }
    })
    moveWorkspaceAfterFirstLookup(desktop, 'local')

    await expect(
      desktop.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).resolves.toMatchObject({ content: '# Phone\n', isDirty: false })
    expect(serverCalls).toEqual(['files.read', 'status.get', FILE_WRITE_IF_UNCHANGED_METHOD])
    expect(pins).toEqual([PAIRING_REVISION, PAIRING_REVISION, PAIRING_REVISION])
    expect(await readFile(readme, 'utf8')).toBe('# Notes\n')
  })

  it('still writes on local disk when it started local, never on a server', async () => {
    const runtime = await runtimeOnHost('local')
    const forwards = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockRejectedValue(new Error('no server'))
    moveWorkspaceAfterFirstLookup(runtime, 'runtime:env-a')

    await expect(
      runtime.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).resolves.toMatchObject({ content: '# Phone\n', isDirty: false })
    expect(await readFile(readme, 'utf8')).toBe('# Phone\n')
    expect(forwards).not.toHaveBeenCalled()
  })
})

describe("a phone's Markdown tab on a raw ssh: host", () => {
  it('refuses it with the same error on read and save', async () => {
    const runtime = await runtimeOnHost('ssh:target-1')
    const forwards = vi.spyOn(runtime, 'callOrchestrationWorkerServer')

    await expect(
      runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, readme)
    ).rejects.toBeInstanceOf(SshHostNotServedError)
    await expect(
      runtime.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Changed\n'
      )
    ).rejects.toBeInstanceOf(SshHostNotServedError)
    expect(forwards).not.toHaveBeenCalled()
  })
})

describe("a phone's Markdown tab on a file an SSH host holds outside the workspace", () => {
  it("refuses it on read and save without touching this machine's file at that path", async () => {
    const runtime = await runtimeOnHost('local', sessionWithReadme('target-1'))

    await expect(
      runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, readme)
    ).rejects.toBeInstanceOf(SshHostNotServedError)
    await expect(
      runtime.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Changed\n'
      )
    ).rejects.toBeInstanceOf(SshHostNotServedError)
    expect(await readFile(readme, 'utf8')).toBe('# Notes\n')
  })
})

describe("a phone's Markdown tab with a desktop window attached", () => {
  function windowTab(
    overrides: Partial<RuntimeMobileSessionMarkdownTab>
  ): RuntimeMobileSessionMarkdownTab {
    return {
      type: 'markdown',
      id: readme,
      title: 'README.md',
      filePath: readme,
      relativePath: 'README.md',
      language: 'markdown',
      mode: 'edit',
      isDirty: false,
      isActive: true,
      sourceFileId: readme,
      sourceFilePath: readme,
      sourceRelativePath: 'README.md',
      documentVersion: `file:${readme}`,
      ...overrides
    }
  }

  function withSavedEditorTabs(session: WorkspaceSessionState): WorkspaceSessionState {
    const files = session.openFilesByWorktree?.[TEST_WORKTREE_ID] ?? []
    const tabs = files.map((file, sortOrder) => ({
      id: file.filePath,
      entityId: file.filePath,
      groupId: 'group-1',
      worktreeId: TEST_WORKTREE_ID,
      contentType: 'editor' as const,
      label: file.relativePath,
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: 1
    }))
    return {
      ...session,
      unifiedTabs: { [TEST_WORKTREE_ID]: tabs },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-1',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: tabs[0]?.id ?? null,
            tabOrder: tabs.map((tab) => tab.id)
          }
        ]
      },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-1' }
    }
  }

  // Main-owned layout reads host partitions, so fixtures must list them like Store.
  function runtimeWithWindowTabs(
    tabs: RuntimeMobileSessionMarkdownTab[],
    session = sessionWithReadme(),
    ownerHostId: 'local' | 'ssh:ssh-1' = 'local'
  ): Runtime {
    const harness = makeRuntimeStoreWithWorkspaceSession(withSavedEditorTabs(session), ownerHostId)
    const repo = { ...store.getRepos()[0]!, executionHostId: ownerHostId }
    const runtime = new OrcaRuntimeService({
      ...harness.runtimeStore,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? repo : undefined),
      getWorkspaceSessionHostIds: () => [ownerHostId]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: tabs[0]?.id ?? null,
          activeTabType: 'markdown',
          tabs
        }
      ]
    })
    return runtime
  }

  it("reads the disk, not the desktop's unsaved text, and says the desktop has some", async () => {
    const runtime = runtimeWithWindowTabs([windowTab({ isDirty: true })])

    await expect(
      runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, readme)
    ).resolves.toMatchObject({
      tabId: readme,
      content: '# Notes\n',
      isDirty: true,
      source: 'file',
      editable: true
    })
  })

  it("reads a preview tab's source file, read-only", async () => {
    const runtime = runtimeWithWindowTabs([
      windowTab({ id: `markdown-preview::${readme}`, mode: 'markdown-preview' })
    ])

    await expect(
      runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, `markdown-preview::${readme}`)
    ).resolves.toMatchObject({
      content: '# Notes\n',
      editable: false,
      readOnlyReason: 'unsupported_preview'
    })
  })

  it('refuses a listed tab whose file the saved session does not hold', async () => {
    const unsaved = join(root, 'not-in-session.md')
    const runtime = runtimeWithWindowTabs([
      windowTab({ id: unsaved, filePath: unsaved, sourceFilePath: unsaved })
    ])

    await expect(runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, unsaved)).rejects.toThrow(
      'tab_not_found'
    )
  })

  it('reads a preview whose source tab was closed from its own file, read-only', async () => {
    const other = join(root, 'other.md')
    await writeFile(other, '# Other\n')
    const runtime = runtimeWithWindowTabs([
      windowTab({
        id: `markdown-preview::${other}`,
        mode: 'markdown-preview',
        filePath: other,
        relativePath: 'other.md',
        sourceFileId: `markdown-preview::${other}`,
        sourceFilePath: other,
        sourceRelativePath: 'other.md'
      })
    ])

    await expect(
      runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, `markdown-preview::${other}`)
    ).resolves.toMatchObject({
      filePath: other,
      content: '# Other\n',
      editable: false,
      readOnlyReason: 'unsupported_preview'
    })
  })

  it('reads an untitled tab read-only and never saves it', async () => {
    const runtime = runtimeWithWindowTabs([windowTab({ isUntitled: true, isDirty: true })])
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await expect(
      runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, readme)
    ).resolves.toMatchObject({
      content: '# Notes\n',
      isDirty: true,
      editable: false,
      readOnlyReason: 'unsupported_untitled'
    })
    await expect(
      runtime.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).rejects.toThrow('unsupported_untitled')
    expect(await readFile(readme, 'utf8')).toBe('# Notes\n')
  })

  it('never makes the file of an untitled tab that has none on disk', async () => {
    const untitled = join(root, 'untitled.md')
    const runtime = runtimeWithWindowTabs(
      [
        windowTab({
          id: untitled,
          filePath: untitled,
          relativePath: 'untitled.md',
          sourceFilePath: untitled,
          sourceRelativePath: 'untitled.md',
          isUntitled: true,
          isDirty: true
        })
      ],
      sessionWithFile(untitled, 'untitled.md')
    )

    await expect(runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, untitled)).rejects.toThrow(
      'ENOENT'
    )
    await expect(
      runtime.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        untitled,
        hashMarkdownContent(''),
        '# Phone\n'
      )
    ).rejects.toThrow('unsupported_untitled')
    expect(existsSync(untitled)).toBe(false)
  })
  it('keeps an SSH-hosted untitled tab read-only, refusing the save before reaching the host', async () => {
    const runtime = runtimeWithWindowTabs(
      [windowTab({ isUntitled: true, isDirty: true })],
      sessionWithReadme(),
      'ssh:ssh-1'
    )

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs.find((tab) => tab.id === readme)).toMatchObject({ isUntitled: true })
    await expect(
      runtime.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        readme,
        hashMarkdownContent('# Notes\n'),
        '# Phone\n'
      )
    ).rejects.toThrow('unsupported_untitled')
    expect(await readFile(readme, 'utf8')).toBe('# Notes\n')
  })
})

describe("a phone's Markdown tab with no window, on a desktop's untitled document", () => {
  it('saves it as an ordinary file, because the saved session does not record untitled', async () => {
    const untitled = join(root, 'untitled.md')
    await writeFile(untitled, '')
    const runtime = await runtimeOnHost('local', sessionWithFile(untitled, 'untitled.md'))

    const read = await runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, untitled)
    expect(read).toMatchObject({ content: '', editable: true })

    await expect(
      runtime.saveMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, untitled, read.version, '# Phone\n')
    ).resolves.toMatchObject({ content: '# Phone\n', isDirty: false })
    expect(await readFile(untitled, 'utf8')).toBe('# Phone\n')
  })
})

describe("a phone's Markdown tab with no window, on a file missing from disk", () => {
  it('fails the read and never makes the file on save', async () => {
    const missing = join(root, 'untitled.md')
    const runtime = await runtimeOnHost('local', sessionWithFile(missing, 'untitled.md'))

    await expect(runtime.readMobileMarkdownTab(`id:${TEST_WORKTREE_ID}`, missing)).rejects.toThrow(
      'ENOENT'
    )
    await expect(
      runtime.saveMobileMarkdownTab(
        `id:${TEST_WORKTREE_ID}`,
        missing,
        hashMarkdownContent(''),
        '# Phone\n'
      )
    ).rejects.toThrow('ENOENT')
    expect(existsSync(missing)).toBe(false)
  })
})
