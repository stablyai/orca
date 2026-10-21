import { execFileSync } from 'node:child_process'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { collectPackageFiles, packageDigest } from './generate-skill-bundle-manifest.mjs'

function option(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
}

// Why: the exact rail Orca runs for both install and update, pinned to this PR's commit.
// A unit test holds it, and this pinned skills CLI, equal to the shared builder's argv.
const PINNED_SKILLS_CLI_VERSION = '1.7.2'

export function roundTripAddArgs(source, ref, skillName, cliVersion = PINNED_SKILLS_CLI_VERSION) {
  return [
    `skills@${cliVersion}`,
    'add',
    `https://github.com/${source}/tree/${ref}`,
    '--skill',
    skillName,
    '--global',
    '--agent',
    'claude-code',
    '--agent',
    'universal',
    '-y'
  ]
}

async function main() {
  // Why: defaults to the version Orca pins; `--cli=latest` previews the next release.
  const cliVersion = option('cli') ?? PINNED_SKILLS_CLI_VERSION
  const autocrlf = option('autocrlf')
  const placement = option('shape')
  // Why: PR refs are untrusted workflow input. Keep them out of the generated shell
  // command and pass them to Node through the environment.
  const source = option('source') ?? process.env.SKILL_UPDATE_SOURCE
  const ref = option('ref') ?? process.env.SKILL_UPDATE_REF
  if (
    (autocrlf !== 'true' && autocrlf !== 'false') ||
    (placement !== 'symlink' && placement !== 'copy') ||
    !source ||
    !ref ||
    !/^[^/\s]+\/[^/\s]+$/.test(source) ||
    // Why: Orca pins to a full commit, never a branch or tag.
    !/^[0-9a-f]{40}$/.test(ref)
  ) {
    throw new Error(
      'Usage: verify-skill-update-roundtrip.mjs [--cli=<version>] --autocrlf=true|false --shape=symlink|copy --source=<owner/repo> --ref=<commit>'
    )
  }

  const sandbox = await mkdtemp(path.join(tmpdir(), 'orca-skill-update-roundtrip-'))
  const home = path.join(sandbox, 'home')
  const stateHome = path.join(home, '.state')
  const targetName = 'orca-cli'
  const controlName = 'orchestration'
  const manifest = JSON.parse(await readFile('resources/skills/current-manifest.json', 'utf8'))

  function currentDigest(name) {
    const skill = manifest.skills.find((entry) => entry.name === name)
    if (!skill) {
      throw new Error(`Current manifest is missing ${name}`)
    }
    return skill.packageDigest
  }

  async function packageDigestAt(directory) {
    return packageDigest(await collectPackageFiles(await realpath(directory)))
  }

  // Why: the copies #26841 stranded: CRLF bytes from no known release, edited, with a
  // sha256 lock hash. The pinned add must replace them all the same.
  async function seedStalePlacement(name) {
    const canonical = path.join(home, '.agents', 'skills', name)
    await mkdir(canonical, { recursive: true })
    const markdown = await readFile(path.join('skills', name, 'SKILL.md'), 'utf8')
    await writeFile(
      path.join(canonical, 'SKILL.md'),
      `${markdown}\nA line no Orca release ever shipped.\n`.replace(/\n/g, '\r\n')
    )
    const providerRoot = path.join(home, '.claude', 'skills')
    const provider = path.join(providerRoot, name)
    await mkdir(providerRoot, { recursive: true })
    await (placement === 'copy'
      ? cp(canonical, provider, { recursive: true })
      : symlink(canonical, provider, process.platform === 'win32' ? 'junction' : 'dir'))
    return { canonical, provider }
  }

  function execSkills(args) {
    const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx'
    const cliArgs = ['--yes', ...args]
    execFileSync(
      executable,
      process.platform === 'win32' ? ['/d', '/s', '/c', 'npx.cmd', ...cliArgs] : cliArgs,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: path.join(home, '.codex'),
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          XDG_STATE_HOME: stateHome,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.autocrlf',
          GIT_CONFIG_VALUE_0: autocrlf,
          CI: '1'
        },
        stdio: 'inherit'
      }
    )
  }

  try {
    const target = await seedStalePlacement(targetName)
    const control = await seedStalePlacement(controlName)
    const controlBefore = await packageDigestAt(control.canonical)
    const lock = {
      version: 3,
      skills: Object.fromEntries(
        [targetName, controlName].map((name) => [
          name,
          {
            source,
            sourceType: 'github',
            sourceUrl: `https://github.com/${source}.git`,
            skillPath: `skills/${name}/SKILL.md`,
            skillFolderHash: 'f'.repeat(64)
          }
        ])
      )
    }
    const lockPath = path.join(stateHome, 'skills', '.skill-lock.json')
    await mkdir(path.dirname(lockPath), { recursive: true })
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

    execSkills(roundTripAddArgs(source, ref, targetName, cliVersion))

    const expected = currentDigest(targetName)
    if ((await packageDigestAt(target.canonical)) !== expected) {
      throw new Error(`${targetName} canonical placement did not become the pinned content`)
    }
    if ((await packageDigestAt(target.provider)) !== expected) {
      throw new Error(`${targetName} claude placement did not become the pinned content`)
    }
    if (placement === 'symlink' && !(await lstat(target.provider)).isSymbolicLink()) {
      throw new Error(`${targetName} provider alias was replaced with an independent copy`)
    }
    const recorded = JSON.parse(await readFile(lockPath, 'utf8')).skills?.[targetName]?.source
    if (typeof recorded !== 'string' || recorded.toLowerCase() !== source.toLowerCase()) {
      throw new Error(`${targetName} lock source is ${recorded}, not ${source}`)
    }
    if ((await packageDigestAt(control.canonical)) !== controlBefore) {
      throw new Error('Targeted add changed the non-targeted control skill')
    }
    if (placement === 'symlink' && !(await lstat(control.provider)).isSymbolicLink()) {
      throw new Error('Targeted add changed the non-targeted control topology')
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main()
}
