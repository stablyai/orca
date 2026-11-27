import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import { resolveFilePath } from './file-open-path'

let base = ''

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function createContext(isRemote: boolean, cwd: string, rootPath: string): HandlerContext {
  return {
    flags: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveFilePath only reads isRemote and calls worktree.show.
    client: {
      isRemote,
      call: async () => ({ result: { worktree: { path: rootPath } } })
    } as unknown as HandlerContext['client'],
    cwd,
    json: false
  }
}

it('resolves ./ against the physical cwd when the worktree root is a symlinked spelling', async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-file-open-')))
  mkdirSync(join(base, 'real', 'repo', 'src'), { recursive: true })
  symlinkSync(join(base, 'real'), join(base, 'alias'), 'junction')
  const ctx = createContext(false, join(base, 'real', 'repo', 'src'), join(base, 'alias', 'repo'))

  expect(await resolveFilePath(ctx, 'id:wt-1', './App.tsx')).toBe('src/App.tsx')
})

const ROOT_TARGET_ERROR = 'The selected worktree root is a directory, not a file-open target.'

it.each([
  { isRemote: false, typedPath: './App.tsx', expected: 'src/App.tsx' },
  { isRemote: true, typedPath: './App.tsx', expected: 'App.tsx' },
  { isRemote: true, typedPath: '.', expected: ROOT_TARGET_ERROR },
  { isRemote: true, typedPath: './', expected: ROOT_TARGET_ERROR }
])(
  'resolves $typedPath from <root>/src (remote: $isRemote)',
  async ({ isRemote, typedPath, expected }) => {
    const root = join(tmpdir(), 'orca-file-open-root')
    const ctx = createContext(isRemote, join(root, 'src'), root)

    const result = await resolveFilePath(ctx, 'id:wt-1', typedPath).catch(
      (error: Error) => error.message
    )

    expect(result).toBe(expected)
  }
)
