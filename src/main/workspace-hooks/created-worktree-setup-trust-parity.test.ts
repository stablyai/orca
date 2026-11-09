import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getSetupTrustContent } from '../../shared/orca-hook-setup-config'
import '../../renderer/src/lib/orca-hook-trust'
import '../runtime/repositories/runtime-repository-hooks-commands'
import { loadHooks } from './hooks'
import { hashOrcaHookTrustContent } from './created-worktree-setup-trust'

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
})

const PINNED_SETUP_HASH = '112aac76dbc70758498c2b87a2dc42e77f7ce366a5b611749ec38b6757681593'
