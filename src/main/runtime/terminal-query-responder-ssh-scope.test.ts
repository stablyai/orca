/**
 * Main's hidden-pane responder resolves an SSH PTY's project theme on the PTY's own host: the
 * runtime record's connectionId (or the app PTY id's embedded target) keys the per-host map, so
 * a local and an SSH PTY of the same repo id answer OSC 11 and ?996n from different palettes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty
} from '../ipc/pty-hidden-delivery-gate'
import { _resetTerminalModelQueryAuthorityForTest } from './terminal-model-query-authority'
import {
  _resetTerminalViewAttributesForTest,
  setRepoTerminalViewAttributes,
  setTerminalViewAttributes
} from './terminal-view-attribute-store'
import type { TerminalViewAttributes, TerminalViewRgb } from '../../shared/terminal-view-attributes'

const store = {
  getRepo: () => undefined,
  getRepos: () => [],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    terminalMainSideEffectAuthority: true,
    terminalHiddenDeliveryGate: true,
    terminalModelQueryAuthority: true
  })
}

function viewAttributes(background: TerminalViewRgb): TerminalViewAttributes {
  return {
    foreground: [0xd0, 0xd0, 0xd0],
    background,
    cursor: [0xff, 0x99, 0x00],
    ansi: Array.from({ length: 256 }, (_, i): TerminalViewRgb => [i, 0, 0]),
    colorSchemeMode: 'dark',
    cursorStyle: 'bar',
    cursorBlink: true
  }
}

const GLOBAL = viewAttributes([0x1e, 0x1e, 0x2e])
const LOCAL_SOLARIZED = viewAttributes([0x00, 0x2b, 0x36])
const REMOTE_SOLARIZED = viewAttributes([0x07, 0x36, 0x42])
const PROBE = '\x1b]11;?\x07\x1b[?996n'

describe('hidden SSH PTYs answer from their own host’s project palette', () => {
  afterEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    _resetTerminalModelQueryAuthorityForTest()
    _resetTerminalViewAttributesForTest()
  })

  async function createRuntime(): Promise<{
    query: (ptyId: string, chunk: string) => Promise<string[]>
    runtime: OrcaRuntimeService
  }> {
    const runtime = new OrcaRuntimeService(store)
    const replies: { ptyId: string; data: string }[] = []
    runtime.setPtyController({
      write: (ptyId, data) => {
        replies.push({ ptyId, data })
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 80, rows: 24 }),
      resize: () => true
    })
    return {
      runtime,
      query: async (ptyId, chunk) => {
        const before = replies.length
        runtime.onPtyData(ptyId, chunk, Date.now())
        // Awaits the per-PTY emulator write chain so the forwarded replies have settled.
        await runtime.serializeMainTerminalBuffer(ptyId)
        return replies.slice(before).map((reply) => reply.data)
      }
    }
  }

  it('keeps a local and an SSH PTY of the SAME repo id on their own hosts’ palettes', async () => {
    const { runtime, query } = await createRuntime()
    runtime.registerPty('ssh:t1@@pty-1', 'repoA::/remote/a', 't1')
    runtime.registerPty('ssh:t2@@pty-1', 'repoA::/remote/a', 't2')
    runtime.registerPty('pty-local', 'repoA::/a')
    for (const ptyId of ['ssh:t1@@pty-1', 'ssh:t2@@pty-1', 'pty-local']) {
      markHiddenRendererPty(ptyId)
    }
    setTerminalViewAttributes(GLOBAL)
    setRepoTerminalViewAttributes({
      byHostId: { local: { repoA: LOCAL_SOLARIZED }, 'ssh:t1': { repoA: REMOTE_SOLARIZED } }
    })

    expect(await query('ssh:t1@@pty-1', PROBE)).toEqual([
      '\x1b]11;rgb:0707/3636/4242\x1b\\',
      '\x1b[?997;1n'
    ])
    expect(await query('pty-local', PROBE)).toEqual([
      '\x1b]11;rgb:0000/2b2b/3636\x1b\\',
      '\x1b[?997;1n'
    ])
    // A host with no themed project stays global, whatever the repo id.
    expect(await query('ssh:t2@@pty-1', '\x1b]11;?\x07')).toEqual([
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'
    ])
  })
})
