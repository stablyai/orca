import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getSetupTrustContent } from '../../shared/orca-hook-setup-config'
import { hashOrcaHookScript } from '../../renderer/src/lib/orca-hook-trust'
import { RuntimeRepositoryHooksCommands } from '../runtime/repositories/runtime-repository-hooks-commands'
import { loadHooks } from './hooks'
import {
  checkCreatedWorktreeSetupTrust,
  hashOrcaHookTrustContent
} from './created-worktree-setup-trust'

// The prompt hashes the primary checkout's orca.yaml; the host hashes the created worktree's.
// Same committed file => same hash, whatever the checkout did to line endings or a BOM.
const SETUP_YAML = [
  'base: &base',
  '  title: Dev server',
  'scripts:',
  '  setup: |',
  '    pnpm install   ',
  '    \techo "tabbed"',
  '',
  '    echo "ünïcødé ✓"',
  'defaultTabs:',
  '  - <<: *base',
  '    command: >',
  '      pnpm dev',
  '      --port 3000',
  '  - title: Notes',
  '  - command: "printf \'%s\\n\' quoted"',
  'issueCommand: gh issue view',
  'scripts_unrelated: ignored',
  ''
].join('\n')

const dirs: string[] = []
function checkout(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-setup-parity-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'orca.yaml'), content)
  return dir
}

const repo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'repo',
  path: '/primary',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0,
  ...overrides
})

/** What the trust prompt approves: the renderer's hash of the primary checkout's content. */
async function promptHash(primaryPath: string): Promise<string> {
  return hashOrcaHookScript(getSetupTrustContent(loadHooks(primaryPath)))
}

beforeEach(() => {
  dirs.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('approved setup hash parity between the trust prompt and the host', () => {
  const variants: [string, (yaml: string) => string][] = [
    ['identical LF files', (yaml) => yaml],
    ['a CRLF primary checkout (Windows autocrlf)', (yaml) => yaml.replace(/\n/g, '\r\n')],
    ['a primary checkout saved with a UTF-8 BOM', (yaml) => `﻿${yaml}`],
    ['a primary checkout with trailing blank lines', (yaml) => `${yaml}\n\n\n`]
  ]

  it.each(variants)('treats %s as the approved content', async (_label, toPrimary) => {
    const primary = checkout(toPrimary(SETUP_YAML))
    const created = checkout(SETUP_YAML)
    const approved = await promptHash(primary)

    expect(
      checkCreatedWorktreeSetupTrust(repo(), loadHooks(created), 'run', {
        approvedSetupHash: approved
      })
    ).toBe(undefined)
  })

  it('agrees with the pure-JS digest the plain-HTTP web client uses', async () => {
    const primary = checkout(SETUP_YAML)
    const subtleHash = await promptHash(primary)
    vi.stubGlobal('crypto', undefined)
    const fallbackHash = await promptHash(primary)

    expect(fallbackHash).toBe(subtleHash)
    expect(hashOrcaHookTrustContent(getSetupTrustContent(loadHooks(primary)))).toBe(subtleHash)
  })

  it('agrees with the hash a runtime host reports to remote and mobile clients', async () => {
    const primary = checkout(SETUP_YAML)
    const created = checkout(SETUP_YAML.replace(/\n/g, '\r\n'))
    const hooks = await new RuntimeRepositoryHooksCommands({
      resolveRepo: async () => repo({ path: primary })
    }).getRepoHooks('id:repo')

    expect(hooks.setupTrust?.contentHash).toBe(await promptHash(primary))
    expect(
      checkCreatedWorktreeSetupTrust(repo(), loadHooks(created), 'run', {
        approvedSetupHash: hooks.setupTrust?.contentHash
      })
    ).toBe(undefined)
  })

  it('ignores orca.yaml keys that are not setup or default tab commands', async () => {
    const primary = checkout(SETUP_YAML)
    const created = checkout(
      SETUP_YAML.replace('issueCommand: gh issue view', 'issueCommand: gh issue view --web')
        .replace('  - title: Notes', '  - title: Scratch')
        .concat('scripts_extra: also ignored\n')
    )

    expect(
      checkCreatedWorktreeSetupTrust(repo(), loadHooks(created), 'run', {
        approvedSetupHash: await promptHash(primary)
      })
    ).toBe(undefined)
  })

  it('pins the digest so a format change, which would invalidate saved automation approvals, is deliberate', () => {
    expect(getSetupTrustContent(loadHooks(checkout(SETUP_YAML)))).toBe(
      [
        'pnpm install   \n\techo "tabbed"\n\necho "ünïcødé ✓"',
        '# defaultTabs[1] Dev server\npnpm dev --port 3000',
        // The double-quoted "\n" escape is a real newline in YAML, on both sides.
        "# defaultTabs[3]\nprintf '%s\n' quoted"
      ].join('\n\n')
    )
    expect(hashOrcaHookTrustContent(getSetupTrustContent(loadHooks(checkout(SETUP_YAML))))).toBe(
      PINNED_SETUP_HASH
    )
  })

  it.each([
    [
      'a changed setup line',
      (yaml: string) => yaml.replace('pnpm install', 'pnpm install && curl x')
    ],
    ['a changed default tab command', (yaml: string) => yaml.replace('--port 3000', '--port 4000')],
    [
      'an added default tab command',
      (yaml: string) =>
        yaml.replace('  - title: Notes', '  - title: Notes\n    command: make serve')
    ]
  ])('still reports %s as a mismatch', async (_label, change) => {
    const primary = checkout(SETUP_YAML)
    const created = checkout(change(SETUP_YAML))

    expect(
      checkCreatedWorktreeSetupTrust(repo(), loadHooks(created), 'run', {
        approvedSetupHash: await promptHash(primary)
      })
    ).toMatchObject({ scriptContent: expect.any(String) })
  })

  it('checks only the shared commands under run-both, as the prompt does', async () => {
    const primary = checkout(SETUP_YAML)
    const created = checkout(SETUP_YAML)
    const runBoth = repo({
      hookSettings: {
        mode: 'auto',
        commandSourcePolicy: 'run-both',
        scripts: { setup: 'echo my own local step', archive: '' }
      }
    })

    expect(
      checkCreatedWorktreeSetupTrust(runBoth, loadHooks(created), 'run', {
        approvedSetupHash: await promptHash(primary)
      })
    ).toBe(undefined)
  })

  it('never reports a mismatch under the local-only policy, where shared setup does not run', async () => {
    const created = checkout(SETUP_YAML)
    const localOnly = repo({
      hookSettings: {
        mode: 'auto',
        commandSourcePolicy: 'local-only',
        scripts: { setup: 'echo mine', archive: '' }
      }
    })

    expect(
      checkCreatedWorktreeSetupTrust(localOnly, loadHooks(created), 'run', {
        approvedSetupHash: 'not-the-hash'
      })
    ).toBe(undefined)
  })

  it('leaves creates without an approval hash (older clients, CLI, stored decisions) unchanged', () => {
    expect(checkCreatedWorktreeSetupTrust(repo(), loadHooks(checkout(SETUP_YAML)), 'run', {})).toBe(
      undefined
    )
  })
})

const PINNED_SETUP_HASH = '112aac76dbc70758498c2b87a2dc42e77f7ce366a5b611749ec38b6757681593'
