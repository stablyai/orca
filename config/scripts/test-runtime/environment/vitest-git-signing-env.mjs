import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Per-checkout, user-owned: a predictable name in a shared /tmp could be planted by another user.
const CACHE_DIR = resolve(import.meta.dirname, '../../../../node_modules/.cache')

function signsByDefault(env) {
  try {
    const values = execFileSync(
      'git',
      [
        'config',
        '--type=bool',
        '--get-regexp',
        '^(commit\\.gpgsign|tag\\.(gpgsign|forcesignannotated))$'
      ],
      { cwd: tmpdir(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return /\strue$/m.test(values)
  } catch {
    return false
  }
}

/**
 * Real-git fixtures must not sign with the developer's key, and `tag.gpgsign` breaks `git tag <name>`.
 * The rest of the global config (e.g. safe.directory) still applies; `~` keeps HOME-isolated fixtures isolated.
 */
export function gitSigningOffEnv(env = process.env) {
  if (!signsByDefault(env)) {
    return {}
  }
  const inherited = env.GIT_CONFIG_GLOBAL
    ? [resolve(env.GIT_CONFIG_GLOBAL)]
    : [
        env.XDG_CONFIG_HOME
          ? join(resolve(env.XDG_CONFIG_HOME), 'git', 'config')
          : '~/.config/git/config',
        '~/.gitconfig'
      ]
  const config = [
    '[include]',
    ...inherited.map((path) => `\tpath = ${JSON.stringify(path.replaceAll('\\', '/'))}`),
    '[commit]',
    '\tgpgsign = false',
    '[tag]',
    '\tgpgsign = false',
    '\tforceSignAnnotated = false',
    ''
  ].join('\n')
  const hash = createHash('sha256').update(config).digest('hex').slice(0, 16)
  const file = join(CACHE_DIR, `orca-vitest-unsigned-${hash}.gitconfig`)
  if (!existsSync(file)) {
    mkdirSync(CACHE_DIR, { recursive: true })
    // Concurrent runs may share the cache; rename so no git ever reads a half-written file.
    const partial = `${file}.${process.pid}`
    writeFileSync(partial, config)
    renameSync(partial, file)
  }
  return { GIT_CONFIG_GLOBAL: file }
}
