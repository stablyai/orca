import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let cacheDirectory

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
  if (!cacheDirectory || !existsSync(cacheDirectory)) {
    // A private random directory cannot be planted by another user in shared temp storage.
    cacheDirectory = mkdtempSync(join(tmpdir(), 'orca-vitest-git-signing-'))
  }
  const hash = createHash('sha256').update(config).digest('hex').slice(0, 16)
  const file = join(cacheDirectory, `orca-vitest-unsigned-${hash}.gitconfig`)
  if (!existsSync(file)) {
    // Publish complete configuration before returning it to git.
    const partial = `${file}.${process.pid}`
    writeFileSync(partial, config)
    renameSync(partial, file)
  }
  return { GIT_CONFIG_GLOBAL: file }
}
