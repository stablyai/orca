import { execFileSync } from 'node:child_process'
import {
  chmod,
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

const cliVersion = option('cli')
const autocrlf = option('autocrlf')
const shape = option('shape')
// Why: PR branch names are untrusted workflow input. Keep them out of the
// generated shell command and pass them to Node through the environment.
const source = option('source') ?? process.env.SKILL_UPDATE_SOURCE
const ref = option('ref') ?? process.env.SKILL_UPDATE_REF
if (
  !cliVersion ||
  (autocrlf !== 'true' && autocrlf !== 'false') ||
  (shape !== 'symlink' && shape !== 'copy') ||
  !source ||
  !ref ||
  !/^[^/\s]+\/[^/\s]+$/.test(source)
) {
  throw new Error(
    'Usage: verify-skill-update-roundtrip.mjs --cli=<version> --autocrlf=true|false --shape=symlink|copy --source=<owner/repo> --ref=<git-ref>'
  )
}

const sandbox = await mkdtemp(path.join(tmpdir(), 'orca-skill-update-roundtrip-'))
const home = path.join(sandbox, 'home')
const stateHome = path.join(home, '.state')
const fakeBin = path.join(sandbox, 'bin')
const targetName = 'orca-cli'
const controlName = 'orchestration'
const manifest = JSON.parse(await readFile('resources/skills/current-manifest.json', 'utf8'))
const registry = JSON.parse(await readFile('resources/skills/snapshot-registry.json', 'utf8'))
const releaseMapping = JSON.parse(await readFile('resources/skills/release-mapping.json', 'utf8'))

function currentSkill(name) {
  const skill = manifest.skills.find((entry) => entry.name === name)
  if (!skill) {
    throw new Error(`Current manifest is missing ${name}`)
  }
  return skill
}

function historicalRelease(name) {
  const current = currentSkill(name)
  for (const release of releaseMapping.releases.toReversed()) {
    const revision = release.skills[name]
    if (typeof revision !== 'number' || revision >= current.releaseRevision) {
      continue
    }
    const snapshot = registry.skills[name]?.find((entry) => entry.releaseRevision === revision)
    if (snapshot) {
      return { tag: `v${release.appVersion}`, snapshot }
    }
  }
  throw new Error(`No historical released snapshot is available for ${name}`)
}

async function materializePackage(name, tag, destination) {
  const prefix = `skills/${name}/`
  const entries = execFileSync('git', ['ls-tree', '-r', '-z', tag, '--', `skills/${name}`])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  if (entries.length === 0) {
    throw new Error(`${tag} does not contain ${name}`)
  }
  for (const entry of entries) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(entry)
    if (!match || match[2] !== 'blob') {
      throw new Error(`Unsupported historical tree entry: ${entry}`)
    }
    const relativePath = match[4].slice(prefix.length)
    const destinationPath = path.join(destination, ...relativePath.split('/'))
    await mkdir(path.dirname(destinationPath), { recursive: true })
    await writeFile(destinationPath, execFileSync('git', ['cat-file', 'blob', match[3]]))
    if (process.platform !== 'win32' && match[1] === '100755') {
      await chmod(destinationPath, 0o755)
    }
  }
}

async function seedPlacement(name, tag) {
  const canonical = path.join(home, '.agents', 'skills', name)
  await materializePackage(name, tag, canonical)
  const providerRoot = path.join(home, '.claude', 'skills')
  const provider = path.join(providerRoot, name)
  await mkdir(providerRoot, { recursive: true })
  await (shape === 'copy'
    ? cp(canonical, provider, { recursive: true })
    : symlink(canonical, provider, process.platform === 'win32' ? 'junction' : 'dir'))
}

async function installFakeAgentCommands() {
  await mkdir(fakeBin, { recursive: true })
  for (const name of ['codex', 'claude']) {
    const executable = path.join(fakeBin, process.platform === 'win32' ? `${name}.cmd` : name)
    await writeFile(
      executable,
      process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n'
    )
    if (process.platform !== 'win32') {
      await chmod(executable, 0o755)
    }
  }
}

async function packageDigestAt(pathValue) {
  return packageDigest(await collectPackageFiles(pathValue))
}

async function assertCurrentCanonical(name) {
  const expected = currentSkill(name).packageDigest
  const canonical = path.join(home, '.agents', 'skills', name)
  if ((await packageDigestAt(canonical)) !== expected) {
    throw new Error(`${name} canonical placement did not update to the PR content`)
  }
}

function execSkills(args) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx'
  const cliArgs = ['--yes', `skills@${cliVersion}`, ...args]
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
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        CI: '1'
      },
      stdio: 'inherit'
    }
  )
}

try {
  const targetHistorical = historicalRelease(targetName)
  const controlHistorical = historicalRelease(controlName)
  await installFakeAgentCommands()
  await mkdir(path.join(home, '.codex'), { recursive: true })
  await mkdir(path.join(home, '.claude'), { recursive: true })
  await seedPlacement(targetName, targetHistorical.tag)
  await seedPlacement(controlName, controlHistorical.tag)
  const targetProvider = path.join(home, '.claude', 'skills', targetName)
  const controlCanonical = path.join(home, '.agents', 'skills', controlName)
  const controlProvider = path.join(home, '.claude', 'skills', controlName)
  const targetProviderBefore = await packageDigestAt(await realpath(targetProvider))
  const controlBefore = await packageDigestAt(controlCanonical)
  const controlProviderBefore = await packageDigestAt(await realpath(controlProvider))

  const timestamp = new Date().toISOString()
  const lock = {
    version: 3,
    skills: {
      [targetName]: {
        source,
        sourceType: 'github',
        sourceUrl: `https://github.com/${source}.git`,
        ref,
        skillPath: `skills/${targetName}/SKILL.md`,
        skillFolderHash: targetHistorical.snapshot.gitTreeSha,
        installedAt: timestamp,
        updatedAt: timestamp
      },
      [controlName]: {
        source,
        sourceType: 'github',
        sourceUrl: `https://github.com/${source}.git`,
        ref,
        skillPath: `skills/${controlName}/SKILL.md`,
        skillFolderHash: controlHistorical.snapshot.gitTreeSha,
        installedAt: timestamp,
        updatedAt: timestamp
      }
    }
  }
  const lockPath = path.join(stateHome, 'skills', '.skill-lock.json')
  await mkdir(path.dirname(lockPath), { recursive: true })
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

  // Why: this is the exact user-visible rail. A bare update would include
  // unrelated vendors, while this command must leave the control skill alone.
  execSkills(['update', targetName, '--global'])
  await assertCurrentCanonical(targetName)
  const targetProviderAfter = await packageDigestAt(await realpath(targetProvider))
  const targetProviderStat = await lstat(targetProvider)
  if (shape === 'symlink' && !targetProviderStat.isSymbolicLink()) {
    throw new Error(`${targetName} provider alias was replaced with an independent copy`)
  }
  if (shape === 'symlink' && targetProviderAfter !== currentSkill(targetName).packageDigest) {
    throw new Error(`${targetName} provider alias did not converge with the canonical update`)
  }
  if (
    shape === 'copy' &&
    targetProviderAfter !== targetProviderBefore &&
    targetProviderAfter !== currentSkill(targetName).packageDigest
  ) {
    throw new Error('Independent provider copy changed to an unexpected package identity')
  }
  if (shape === 'copy') {
    // Why: hosted 1.5.17 replaces copies with aliases while equivalent local runs
    // retain the copy. Both prove this input topology must remain ineligible.
    const outcome = targetProviderStat.isSymbolicLink()
      ? 'converged to an alias'
      : targetProviderAfter === targetProviderBefore
        ? 'remained a historical copy'
        : 'converged as a copy'
    console.log(`[skill-update-roundtrip] independent copy ${outcome}`)
  }
  if ((await packageDigestAt(controlCanonical)) !== controlBefore) {
    throw new Error('Targeted update changed the non-targeted control skill')
  }
  if ((await packageDigestAt(await realpath(controlProvider))) !== controlProviderBefore) {
    throw new Error('Targeted update changed the non-targeted control provider placement')
  }
  const controlProviderStat = await lstat(controlProvider)
  if (shape === 'symlink' && !controlProviderStat.isSymbolicLink()) {
    throw new Error('Targeted update changed the non-targeted control topology')
  }
} finally {
  await rm(sandbox, { recursive: true, force: true })
}
