import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { stripComments } from '../../shared/source-scan/source-tree-scan'

const src = join(__dirname, '../..')

/**
 * Every place a Claude login could be written from: accounts, usage, launch, hooks, the CLI, the
 * relay and the generated shell scripts. Plan §9 lists these; credential checks run on all of them.
 */
const credentialRoots: readonly (string | { root: string; only: RegExp })[] = [
  'main/claude-accounts',
  // Other providers there refresh their own logins; only Claude's usage is in scope.
  { root: 'main/rate-limits', only: /[\\/]claude[^\\/]*\.ts$/ },
  'main/claude',
  'main/native-chat',
  'main/ipc/pty',
  'main/daemon',
  'main/providers',
  'main/macos-keychain',
  'cli',
  'relay',
  'shared'
]

/**
 * Only noncredential profile surfaces may persist bytes, and each only with the primitives it
 * uses today; a new primitive in one of them is a review, not a silent pass.
 */
const fsAllowances: Record<string, readonly string[]> = {
  'claude-accounts/claude-profile-history.ts': [
    'mkdirSync',
    'renameSync',
    'rmdirSync',
    'symlinkSync'
  ],
  'claude-accounts/claude-profile-paths.ts': ['mkdirSync', 'writeFileAtomically'],
  // The which-account file.
  'claude-accounts/claude-profile-router.ts': ['mkdirSync', 'rmSync', 'writeFileAtomically'],
  // Removing an account deletes its folder, links first.
  'claude-accounts/claude-account-folder.ts': ['rmSync', 'rmdirSync', 'unlinkSync'],
  'claude-accounts/claude-profile-prompt-history.ts': [
    'appendFileSync',
    'linkSync',
    'openSync',
    'renameSync',
    'rmSync',
    'symlinkSync',
    'unlinkSync',
    'writeFileSync',
    'writeFileAtomically'
  ],
  'claude-accounts/claude-profile-provisioning.ts': ['mkdirSync', 'rmSync', 'writeFileAtomically'],
  'claude-accounts/claude-profile-sharing.ts': [
    'mkdirSync',
    'rmdirSync',
    'symlinkSync',
    'unlinkSync',
    'writeFileAtomically'
  ],
  // The guest helper answers the host on stdout.
  'claude-accounts/claude-profile-wsl-entry.ts': ['write'],
  // Which PTY runs which `--account` account, for labels: ids only, never a login.
  'claude-accounts/claude-pinned-pty-registry.ts': ['mkdirSync', 'write', 'writeFileAtomically']
}
const mutation =
  /^(?:write(?:File|Json|Sync|v|.*Credentials|.*Keychain)?$|write(?:File|Json)|appendFile|copyFile|cp(?:Sync)?$|rename(?:Sync)?$|unlink(?:Sync)?$|rm(?:dir)?(?:Sync)?$|truncate(?:Sync)?$|createWriteStream|symlink(?:Sync)?$|link(?:Sync)?$|chmod(?:Sync)?$|mkdir(?:Sync)?$|mkdtemp(?:Sync)?$|open(?:Sync)?$|delete.*Keychain|refreshClaudeOauth)/

function persistencePrimitives(text: string): string[] {
  const found = new Set<string>()
  // Import-side names survive aliases, including destructuring and wrapped helper calls.
  for (const match of text.matchAll(/\b([a-zA-Z_$][\w$]*)\s*(?=\(|as\s|[:,}])/g)) {
    if (mutation.test(match[1])) {
      found.add(match[1])
    }
  }
  return [...found]
}

const WRITE_CALL =
  /\b(?:write\w*|append\w*|copy\w*|cp(?:Sync)?|rename\w*|link\w*|symlink\w*|createWriteStream)\s*\(/g
// The one runner that takes `security` argv from its callers; each caller must spell the verb.
const SECURITY_RUNNER = 'main/macos-keychain/generic-password.ts'
// Removing an account deletes the Keychain items Claude made for its folder; nothing adds one.
const KEYCHAIN_DELETE_OWNER = 'main/claude-accounts/claude-account-folder.ts'

/** Names bound, directly or through another such name, to the credentials file's path. */
function credentialFileNames(text: string): Set<string> {
  const declarations: { name: string; init: string }[] = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const declared = /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (!declared) {
      return
    }
    const indent = declared[1].length
    let end = index + 1
    while (end < lines.length && /^\s*$|^\s+/.test(lines[end])) {
      const lead = /^\s*/.exec(lines[end])?.[0].length ?? 0
      if (lines[end].trim() && lead <= indent && !/^\s*[)\]}]/.test(lines[end])) {
        break
      }
      end += 1
    }
    declarations.push({ name: declared[2], init: lines.slice(index, end).join('\n') })
  })
  const names = new Set<string>()
  for (let changed = true; changed;) {
    changed = false
    for (const { name, init } of declarations) {
      const tainted =
        init.includes('.credentials.json') ||
        [...names].some((other) => new RegExp(`\\b${other}\\b`).test(init.replace(name, '')))
      if (tainted && !names.has(name)) {
        names.add(name)
        changed = true
      }
    }
  }
  return names
}

/** Credential writes refused everywhere scanned, whatever form the call takes. */
function credentialMutations(text: string, file = ''): string[] {
  const found: string[] = []
  // A `security` launch whose verb is not spelled out could be a write, so only the runner may
  // forward argv, and its callers must spell the verb.
  if (
    (file !== SECURITY_RUNNER &&
      /\b(?:exec(?:File)?(?:Sync|Async)?|spawn(?:Sync)?|runProcess|spawnProcess)\s*\(\s*['"`]security['"`]\s*,\s*(?!\[\s*['"])/.test(
        text
      )) ||
    /\bprogram\s*:\s*['"`]security['"`]\s*,\s*args\s*:\s*(?!\[\s*['"])/.test(text) ||
    /(?<!function\s)\bexecSecurityCommand\s*\(\s*(?!\[\s*['"])/.test(text)
  ) {
    found.push('keychain command with a computed verb')
  }
  // A name bound to the credentials file that reaches a write, anywhere in the same file.
  const names = credentialFileNames(text)
  for (const call of text.matchAll(WRITE_CALL)) {
    const args = text.slice(call.index + call[0].length, call.index + call[0].length + 300)
    if ([...names].some((name) => new RegExp(`\\b${name}\\b`).test(args))) {
      found.push('credentials file write through a name')
      break
    }
  }
  // Argv (`['add-generic-password', …]`) and shell (`security add-generic-password`) forms.
  if (
    /add-generic-password/.test(text) ||
    (file !== KEYCHAIN_DELETE_OWNER && /delete-generic-password/.test(text))
  ) {
    found.push('keychain write')
  }
  if (/\b(?:write|delete|store|save)\w*Keychain\w*\b/.test(text)) {
    found.push('keychain helper')
  }
  if (/oauth\/token|grant_type|\brefresh_token\b/.test(text)) {
    found.push('token refresh')
  }
  // A statement that names the credentials file together with anything that writes, copies,
  // moves or opens it for writing (TS calls and generated shell alike).
  for (const statement of text.split(/;|\n\s*\n/)) {
    if (
      statement.includes('.credentials.json') &&
      /\b(?:write\w*|append\w*|copy\w*|cp(?:Sync)?|rename\w*|link\w*|symlink\w*|createWriteStream|mv|tee|install)\b|\bopen(?:Sync)?\s*\([\s\S]{0,200}?,\s*['"`](?:w|a|r\+|wx|ax)|>\s*["'$]/.test(
        statement
      )
    ) {
      found.push('credentials file write')
    }
  }
  return found
}

function files(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name)
    return entry.isDirectory()
      ? entry.name === 'node_modules' || entry.name === '__fixtures__'
        ? []
        : files(file)
      : /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh)$/.test(entry.name) &&
          !/\.test\.|\.spec\.|test-harness|harness\.ts|test-fixtures|test-utils/.test(entry.name)
        ? [file]
        : []
  })
}

it('keeps every Claude credential writer removed, in every form and on every launch path', () => {
  const violations = credentialRoots
    .flatMap((entry) => {
      const { root, only } = typeof entry === 'string' ? { root: entry, only: null } : entry
      const dir = join(src, root)
      const found = statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? files(dir) : []
      return only ? found.filter((file) => only.test(file)) : found
    })
    .flatMap((file) =>
      credentialMutations(
        stripComments(readFileSync(file, 'utf8')),
        relative(src, file).replaceAll('\\', '/')
      ).map((kind) => `${relative(src, file)}: ${kind}`)
    )
  expect(violations).toEqual([])
})

it('confines filesystem persistence in accounts and usage to named profile surfaces', () => {
  const main = join(src, 'main')
  const candidates = [
    ...files(__dirname),
    ...files(join(main, 'rate-limits')).filter((file) => /\/claude[^/]*\.ts$/.test(file))
  ]
  const violations = candidates.flatMap((file) => {
    const name = relative(main, file).replaceAll('\\', '/')
    const allowed = new Set(fsAllowances[name] ?? [])
    return persistencePrimitives(stripComments(readFileSync(file, 'utf8')))
      .filter((primitive) => !allowed.has(primitive))
      .map((primitive) => `${name}: ${primitive}`)
  })
  expect(violations).toEqual([])
  const cli = readFileSync(join(main, '../cli/handlers/account.ts'), 'utf8')
  expect(cli).not.toMatch(/Keychain|orca-account-add-claude|addClaudeFromConfigDir/)
  const auth = readFileSync(join(__dirname, 'runtime-auth-service.ts'), 'utf8')
  expect(auth).not.toMatch(/extends ClaudeRuntimeAuth|snapshot|credentialsJson|readBack/i)
})

it.each([
  "import { writeFile as save } from 'node:fs/promises'; save(path, token)",
  "import * as fs from 'node:fs'; const save = () => fs.writeFileSync(path, token)",
  "import { writeFileAtomically as persist } from '../codex-accounts/fs-utils'; persist(path, token)",
  'fs.copyFile(source, destination)',
  'fs.symlink(credentialPath, destination)',
  "const fd = openSync(join(dir, 'x'), 'w'); writeSync(fd, token)",
  'await fs.promises.cp(a, b)',
  'fs.cpSync(a, b, { recursive: true })'
])('mutation control: the filesystem census rejects %s', (source) => {
  expect(persistencePrimitives(source).length).toBeGreaterThan(0)
})

it.each([
  'security add-generic-password -s Claude -w token',
  "await execFileAsync('security', ['add-generic-password', '-U', '-s', service, '-w', token])",
  "execFileSync('security', ['delete-generic-password', '-s', 'Claude Code-credentials'])",
  "import { writeKeychainPassword as persist } from '../macos-keychain/generic-password'; persist(service, user, token)",
  "const fd = openSync(join(dir, '.credentials.json'), 'w'); writeSync(fd, token)",
  "await fs.promises.cp(join(a, '.credentials.json'), join(b, '.credentials.json'))",
  "copyFileSync(join(from, '.credentials.json'), join(home, '.credentials.json'))",
  "const script = 'cp source .credentials.json'",
  'const script = `printf %s "$token" > "$HOME/.claude/.credentials.json"`',
  "fetch('https://api.anthropic.com/v1/oauth/token')",
  "body: JSON.stringify({ grant_type: 'refresh_token' })",
  "execFile('security', [['add', 'generic', 'password'].join('-'), '-s', service])",
  "spawn('security', verbArgs)",
  'execSecurityCommand(args)',
  "const CREDENTIALS_FILE = '.credentials.json'\n\ncopyFileSync(join(from, CREDENTIALS_FILE), join(to, CREDENTIALS_FILE))",
  "const name = '.credentials.json'\nfunction save(dir) {\n  const target = join(dir, name)\n\n  writeFileSync(target, token)\n}"
])('mutation control: the credential check rejects %s', (source) => {
  expect(credentialMutations(source).length).toBeGreaterThan(0)
})

it.each([
  "const file = await readFile(join(home, '.credentials.json'), 'utf8')",
  "readKeychainPassword('Claude Code-credentials', user)",
  "execSecurityCommand(['find-generic-password', '-s', service, '-w'])",
  "const file = join(home, '.credentials.json')\nconst raw = await readFile(file, 'utf8')"
])('the credential check leaves a read alone: %s', (source) => {
  expect(credentialMutations(source)).toEqual([])
})

it('lets only account removal delete a Keychain item, and nothing add one', () => {
  const remove = "execSecurityCommand(['delete-generic-password', '-s', service])"
  expect(credentialMutations(remove, KEYCHAIN_DELETE_OWNER)).toEqual([])
  expect(credentialMutations(remove, 'main/claude-accounts/service.ts')).not.toEqual([])
  expect(
    credentialMutations(
      "execSecurityCommand(['add-generic-password', '-s', service])",
      KEYCHAIN_DELETE_OWNER
    )
  ).not.toEqual([])
})
