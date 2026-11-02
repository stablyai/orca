import { describe, expect, it } from 'vitest'

import {
  importsDeprecatedRuntimeOwner,
  isScannedPath
} from './check-deprecated-runtime-owner-ratchet.mjs'

describe('importsDeprecatedRuntimeOwner', () => {
  it('finds a named import of either deprecated resolver', () => {
    expect(
      importsDeprecatedRuntimeOwner(
        "import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'\n"
      )
    ).toBe(true)
    expect(
      importsDeprecatedRuntimeOwner(
        "import {\n  foo,\n  resolveRuntimeOwnerForWorktree\n} from './worktree-runtime-owner'\n"
      )
    ).toBe(true)
  })

  it('finds an aliased import, a re-export and a dynamic import', () => {
    expect(
      importsDeprecatedRuntimeOwner(
        "import { getRuntimeEnvironmentIdForWorktree as envFor } from '@/lib/worktree-runtime-owner'"
      )
    ).toBe(true)
    expect(
      importsDeprecatedRuntimeOwner(
        "export { resolveRuntimeOwnerForWorktree } from './worktree-runtime-owner'"
      )
    ).toBe(true)
    expect(
      importsDeprecatedRuntimeOwner(
        "const { getRuntimeEnvironmentIdForWorktree } = await import('@/lib/worktree-runtime-owner')"
      )
    ).toBe(true)
  })

  it('finds a use through a namespace import or a module-valued dynamic import', () => {
    expect(
      importsDeprecatedRuntimeOwner(
        "import * as owner from '@/lib/worktree-runtime-owner'\nowner.getRuntimeEnvironmentIdForWorktree(s, id)"
      )
    ).toBe(true)
    expect(
      importsDeprecatedRuntimeOwner(
        "const mod = await import('@/lib/worktree-runtime-owner')\nmod.resolveRuntimeOwnerForWorktree(s, id)"
      )
    ).toBe(true)
  })

  it('finds destructuring in a promise-based dynamic import', () => {
    expect(
      importsDeprecatedRuntimeOwner(
        "import('@/lib/worktree-runtime-owner').then(({ resolveRuntimeOwnerForWorktree }) => resolveRuntimeOwnerForWorktree(s, id))"
      )
    ).toBe(true)
  })

  it('reads through comments inside an import list, and ignores a commented-out import', () => {
    expect(
      importsDeprecatedRuntimeOwner(
        "import { /* legacy */ getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'"
      )
    ).toBe(true)
    expect(
      importsDeprecatedRuntimeOwner(
        "import {\n  a, // keep\n  resolveRuntimeOwnerForWorktree\n} from './worktree-runtime-owner'"
      )
    ).toBe(true)
    expect(
      importsDeprecatedRuntimeOwner(
        "// import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'\n/* owner.resolveRuntimeOwnerForWorktree() */"
      )
    ).toBe(false)
  })

  it('ignores other names from the module, and same-named functions from other modules', () => {
    expect(
      importsDeprecatedRuntimeOwner(
        "import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'"
      )
    ).toBe(false)
    expect(
      importsDeprecatedRuntimeOwner(
        "import { getRuntimeEnvironmentIdForWorktree } from '@/lib/other-owner'"
      )
    ).toBe(false)
  })
})

describe('isScannedPath', () => {
  it('scans renderer sources only, not tests or the defining module', () => {
    expect(isScannedPath('src/renderer/src/store/terminals/terminal-shutdown.ts')).toBe(true)
    expect(isScannedPath('src/renderer/src/store/terminals/terminal-shutdown.test.ts')).toBe(false)
    expect(isScannedPath('src/renderer/src/store/host-twin.test-fixture.ts')).toBe(false)
    expect(isScannedPath('src/renderer/src/lib/worktree-runtime-owner.ts')).toBe(false)
    expect(isScannedPath('src/main/runtime/foo.ts')).toBe(false)
  })
})
