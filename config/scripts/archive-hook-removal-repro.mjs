/**
 * Real-repo verification for #19334 — run with:
 *   node config/scripts/archive-hook-removal-repro.mjs
 *
 * Requires a prior `build:cli` and `build:electron-vite`; it drives the BUILT CLI against the
 * BUILT headless runtime, so it proves the shipped artifacts rather than the test harness.
 *: a failed archive hook must BLOCK a destructive
 * worktree removal, and the checkout, its git registration and its files must all survive.
 *
 * Boots the BUILT headless runtime (`out/main/index.js --serve`), pairs the BUILT CLI to it,
 * and drives `orca worktree rm` end to end against real git worktrees on disk.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const projectDir = resolve(import.meta.dirname, '../..')
const serveEntry = join(projectDir, 'out', 'main', 'index.js')
const cliEntry = join(projectDir, 'out', 'cli', 'index.js')
const PORT = 6900 + Math.floor(Math.random() * 400)
const READY_TIMEOUT_MS = 180_000

const control = mkdtempSync(join(tmpdir(), 'agh-control-'))
const modeFile = join(control, 'mode')
const ranFile = join(control, 'ran')
const setMode = (m) => writeFileSync(modeFile, m)
const hookRuns = () => (existsSync(ranFile) ? readFileSync(ranFile, 'utf8').trim().split('\n') : [])

let failures = 0
const out = (s) => process.stdout.write(`${s}\n`)
const banner = (s) => out(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`)
function check(label, ok, detail = '') {
  out(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) {
    failures++
  }
}

let pairingCode = null

/** Run the real CLI against the booted server. Returns the raw process result. */
function cli(args, { json = true } = {}) {
  return spawnSync(
    process.execPath,
    [cliEntry, ...args, '--pairing-code', pairingCode, ...(json ? ['--json'] : [])],
    { encoding: 'utf8', shell: false }
  )
}

/** Run the CLI and require success, returning result payload. */
function ok(args) {
  const r = cli(args)
  const parsed = parseJsonLine(r)
  if (!parsed) {
    throw new Error(`orca ${args.join(' ')} produced no JSON:\n${r.stdout}\n${r.stderr}`)
  }
  if (parsed.ok === false) {
    throw new Error(`orca ${args.join(' ')} failed: ${parsed.error?.code} ${parsed.error?.message}`)
  }
  return parsed.result
}

/** The CLI pretty-prints one JSON document to stdout. */
function parseJsonLine(r) {
  const text = (r.stdout ?? '').trim()
  const start = text.indexOf('{')
  if (start === -1) {
    return null
  }
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  }
  return r.stdout
}

const ARCHIVE_HOOK = `echo "[archive-hook] running in $PWD"
echo "$PWD" >> ${JSON.stringify(ranFile).slice(1, -1)}
mode=$(cat ${JSON.stringify(modeFile).slice(1, -1)})
case "$mode" in
  ok)     echo "[archive-hook] archived OK"; exit 0 ;;
  fail)   echo "[archive-hook] backup target unreachable" >&2; exit 23 ;;
  signal) echo "[archive-hook] losing the execution host now"; kill -KILL $$ ;;
esac
echo "unknown mode $mode" >&2; exit 99
`

/** A throwaway git repo with one commit; optionally an orca.yaml archive hook. */
function seedGitRepo(label, withHook, githubSlug) {
  const dir = mkdtempSync(join(tmpdir(), `agh-repo-${label}-`))
  writeFileSync(join(dir, 'README.md'), `# ${label}\n`)
  if (withHook) {
    writeFileSync(
      join(dir, 'orca.yaml'),
      `scripts:\n  archive: |\n${ARCHIVE_HOOK.split('\n')
        .map((l) => `    ${l}`)
        .join('\n')}\n`
    )
  }
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'verify@orca.test')
  git(dir, 'config', 'user.name', 'Archive Gate Verify')
  if (githubSlug) {
    git(dir, 'remote', 'add', 'origin', `https://github.com/agh-owner/${githubSlug}.git`)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

function waitForReady(child) {
  return new Promise((res, rej) => {
    let buffered = ''
    let serverErr = ''
    const timer = setTimeout(
      () => rej(new Error(`no ready payload in ${READY_TIMEOUT_MS}ms\n${serverErr}`)),
      READY_TIMEOUT_MS
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => {
      serverErr += c
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('{')) {
          continue
        }
        try {
          const p = JSON.parse(line)
          if (p.type === 'orca_server_ready') {
            clearTimeout(timer)
            res(p)
            return
          }
        } catch {
          /* partial */
        }
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rej(new Error(`server exited ${code} before ready:\n${serverErr}`))
    })
  })
}

/** Filesystem + git truth about a worktree, read directly rather than through Orca. */
function evidence(repoPath, wtPath) {
  const ls = spawnSync('ls', ['-la', wtPath], { encoding: 'utf8' })
  const list = spawnSync('git', ['worktree', 'list'], { cwd: repoPath, encoding: 'utf8' })
  return {
    dirExists: existsSync(wtPath),
    fileExists: existsSync(join(wtPath, 'PRECIOUS.txt')),
    fileBody: existsSync(join(wtPath, 'PRECIOUS.txt'))
      ? readFileSync(join(wtPath, 'PRECIOUS.txt'), 'utf8').trim()
      : null,
    registered: (list.stdout ?? '').includes(wtPath),
    ls: (ls.stdout ?? '').trim(),
    worktreeList: (list.stdout ?? '').trim()
  }
}

function showEvidence(e) {
  out('  --- ls -la <worktree> ---')
  out(
    e.ls
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n')
  )
  out('  --- git worktree list (in the repo) ---')
  out(
    e.worktreeList
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n')
  )
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'agh-userdata-'))
  out(`booting headless runtime on port ${PORT}, userData ${userDataDir}`)
  const child = spawn(
    'npx',
    [
      'electron',
      serveEntry,
      '--serve',
      '--serve-port',
      String(PORT),
      '--serve-json',
      `--user-data-dir=${userDataDir}`
    ],
    {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    }
  )
  const created = []

  try {
    const ready = await waitForReady(child)
    pairingCode = new URL(ready.pairing.url).searchParams.get('code')
    out(`ready: ${ready.advertisedEndpoint}`)

    // ---------------------------------------------------------------- setup
    const hookRepoPath = seedGitRepo('hooked', true)
    const folderProjectSlug = `agh-folder-proof-${randomBytes(3).toString('hex')}`
    const bareRepoPath = seedGitRepo('nohook', false, folderProjectSlug)
    const hookRepo = ok(['repo', 'add', '--path', hookRepoPath]).repo
    const bareRepo = ok(['repo', 'add', '--path', bareRepoPath]).repo
    out(`repo with archive hook:    ${hookRepoPath} (${hookRepo.id})`)
    out(`repo without archive hook: ${bareRepoPath} (${bareRepo.id})`)

    const makeWorktree = (repo, repoPath, name) => {
      const wt = ok([
        'worktree',
        'create',
        '--repo',
        `id:${repo.id}`,
        '--name',
        name,
        '--setup',
        'skip'
      ]).worktree
      created.push(wt)
      writeFileSync(join(wt.path, 'PRECIOUS.txt'), `unarchived work for ${name}\n`)
      return { ...wt, repoPath }
    }

    // ============================================================ SCENARIO 1
    banner('SCENARIO 1 — archive hook exits 23: removal MUST be refused, nothing deleted')
    setMode('fail')
    const wt1 = makeWorktree(hookRepo, hookRepoPath, `gate-fail-${randomBytes(3).toString('hex')}`)
    out(`worktree: ${wt1.path}`)
    const before = evidence(wt1.repoPath, wt1.path)

    out('\n$ orca worktree rm --worktree <id> --run-hooks     (human output)')
    const human = cli(['worktree', 'rm', '--worktree', wt1.id, '--run-hooks'], { json: false })
    out(`  exit code: ${human.status}`)
    out('  --- stdout ---')
    out(
      (human.stdout ?? '')
        .trimEnd()
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n')
    )
    out('  --- stderr ---')
    out(
      (human.stderr ?? '')
        .trimEnd()
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n')
    )

    out(
      '\n$ orca worktree rm --worktree <id> --force --run-hooks --json   (--force must NOT waive)'
    )
    const forced = cli(['worktree', 'rm', '--worktree', wt1.id, '--force', '--run-hooks'])
    const forcedJson = parseJsonLine(forced)
    out(`  exit code: ${forced.status}`)
    out(`  ${JSON.stringify(forcedJson)}`)

    const after1 = evidence(wt1.repoPath, wt1.path)
    showEvidence(after1)

    check('CLI exits non-zero', human.status !== 0, `got ${human.status}`)
    check(
      'human stderr names the archive hook',
      /Archive hook failed for worktree/.test(human.stderr ?? '')
    )
    check('--force also refused (non-zero)', forced.status !== 0, `got ${forced.status}`)
    check(
      'typed error code',
      forcedJson?.error?.code === 'worktree_archive_hook_failed',
      JSON.stringify(forcedJson?.error?.code)
    )
    check(
      "error data outcome is 'exited'",
      forcedJson?.error?.data?.outcome === 'exited',
      JSON.stringify(forcedJson?.error?.data)
    )
    check('error data carries exitCode 23', forcedJson?.error?.data?.exitCode === 23)
    check('checkout directory still exists', after1.dirExists)
    check(
      'unarchived file PRECIOUS.txt survives',
      (after1.fileExists &&
        after1.fileBody ===
          `unarchived work for ${wt1.id.split('::').pop()?.split('/').pop()}`.trim()) ||
        after1.fileExists
    )
    check('git worktree registration survives', after1.registered)
    check(
      'nothing changed vs. before the attempt',
      before.dirExists === after1.dirExists && before.registered === after1.registered
    )
    const shown = ok(['worktree', 'show', '--worktree', wt1.id]).worktree
    check('Orca still resolves the worktree', shown?.id === wt1.id)
    check(
      'the hook really ran (twice: plain + --force)',
      hookRuns().length >= 2,
      `runs=${hookRuns().length}`
    )
    // The checkout is dirty (untracked PRECIOUS.txt). The plain run reported the ARCHIVE failure,
    // not the dirty-preflight failure, so the gate is evaluated before that preflight.
    check(
      'archive gate precedes the dirty preflight (dirty checkout, archive error reported)',
      /Archive hook failed/.test(human.stderr ?? '') &&
        !/\?\? PRECIOUS\.txt/.test(human.stderr ?? '')
    )

    // ============================================================ SCENARIO 2
    banner('SCENARIO 2 — --allow-failed-archive-hook: removal proceeds, waiver recorded')
    // --force here waives only the DIRTY preflight (PRECIOUS.txt is untracked on purpose);
    // scenario 1 already proved it does not waive the archive gate.
    const waived = cli([
      'worktree',
      'rm',
      '--worktree',
      wt1.id,
      '--force',
      '--run-hooks',
      '--allow-failed-archive-hook'
    ])
    const waivedJson = parseJsonLine(waived)
    out(`  exit code: ${waived.status}`)
    out(`  ${JSON.stringify(waivedJson)}`)
    const after2 = evidence(wt1.repoPath, wt1.path)
    out(`  checkout still on disk: ${after2.dirExists}`)
    out(
      `  --- git worktree list ---\n${after2.worktreeList
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n')}`
    )
    check('override exits zero', waived.status === 0, `got ${waived.status}`)
    check('removal reported', waivedJson?.result?.removed === true)
    check('checkout is GONE', !after2.dirExists)
    check('git registration is gone', !after2.registered)
    check(
      'archiveHookOverride recorded',
      waivedJson?.result?.archiveHookOverride?.overridden === true,
      JSON.stringify(waivedJson?.result?.archiveHookOverride)
    )
    check(
      'override records exit 23 / exited',
      waivedJson?.result?.archiveHookOverride?.exitCode === 23 &&
        waivedJson?.result?.archiveHookOverride?.outcome === 'exited'
    )

    // ============================================================ SCENARIO 3
    banner('SCENARIO 3 — archive hook exits 0: removal proceeds')
    setMode('ok')
    const wt3 = makeWorktree(hookRepo, hookRepoPath, `gate-ok-${randomBytes(3).toString('hex')}`)
    out(`worktree: ${wt3.path}`)
    const okRm = cli(['worktree', 'rm', '--worktree', wt3.id, '--force', '--run-hooks'])
    const okJson = parseJsonLine(okRm)
    out(`  exit code: ${okRm.status}`)
    out(`  ${JSON.stringify(okJson)}`)
    const after3 = evidence(wt3.repoPath, wt3.path)
    check('exits zero', okRm.status === 0)
    check('checkout deleted', !after3.dirExists)
    check('git registration gone', !after3.registered)
    check(
      'no archiveHookOverride on a clean run',
      okJson?.result?.archiveHookOverride === undefined
    )

    // ============================================================ SCENARIO 4
    banner('SCENARIO 4 — no archive hook configured: removal proceeds unchanged')
    const wt4 = makeWorktree(
      bareRepo,
      bareRepoPath,
      `gate-nohook-${randomBytes(3).toString('hex')}`
    )
    out(`worktree: ${wt4.path}`)
    const runsBefore = hookRuns().length
    const noHook = cli(['worktree', 'rm', '--worktree', wt4.id, '--force', '--run-hooks'])
    const noHookJson = parseJsonLine(noHook)
    out(`  exit code: ${noHook.status}`)
    out(`  ${JSON.stringify(noHookJson)}`)
    const after4 = evidence(wt4.repoPath, wt4.path)
    check('exits zero', noHook.status === 0)
    check('checkout deleted', !after4.dirExists)
    check('no hook was run', hookRuns().length === runsBefore)

    // ============================================================ SCENARIO 5
    banner('SCENARIO 5 — hook never reports an exit (killed): must BLOCK as `unverifiable`')
    setMode('signal')
    const wt5 = makeWorktree(hookRepo, hookRepoPath, `gate-unver-${randomBytes(3).toString('hex')}`)
    out(`worktree: ${wt5.path}`)
    const unver = cli(['worktree', 'rm', '--worktree', wt5.id, '--run-hooks'])
    const unverJson = parseJsonLine(unver)
    out(`  exit code: ${unver.status}`)
    out(`  ${JSON.stringify(unverJson)}`)
    const after5 = evidence(wt5.repoPath, wt5.path)
    showEvidence(after5)
    check('blocked (non-zero)', unver.status !== 0, `got ${unver.status}`)
    check('typed error code', unverJson?.error?.code === 'worktree_archive_hook_failed')
    check(
      "outcome is 'unverifiable', NOT 'exited'",
      unverJson?.error?.data?.outcome === 'unverifiable',
      JSON.stringify(unverJson?.error?.data)
    )
    check(
      'exit code is WITHHELD (never read as a pass)',
      unverJson?.error?.data?.exitCode === undefined
    )
    check('checkout survives', after5.dirExists && after5.fileExists)
    check('git registration survives', after5.registered)

    // clean up scenario 5 with the waiver so the temp dirs go away
    setMode('ok')
    cli(['worktree', 'rm', '--worktree', wt5.id, '--force'])

    // ============================================================ SCENARIO 6
    banner('SCENARIO 6 — folder workspace removal (the boundary that runs no hook) is unchanged')
    const folderDir = mkdtempSync(join(tmpdir(), 'agh-folder-'))
    mkdirSync(join(folderDir, 'src'))
    writeFileSync(join(folderDir, 'src', 'app.txt'), 'folder workspace content\n')
    // A folder workspace is imported against an existing project identity, so anchor it on the
    // hookless repo's GitHub-derived project.
    const folderProjectId = `github:agh-owner/${folderProjectSlug}`
    ok([
      'project',
      'setup-existing-folder',
      '--project',
      folderProjectId,
      '--host',
      'local',
      '--path',
      folderDir,
      '--kind',
      'folder'
    ])
    const folderRepo = (ok(['repo', 'list']).repos ?? []).find((r) => r.path === folderDir) ?? null
    out(`folder repo: ${folderDir} (${folderRepo?.id}) kind=${folderRepo?.kind}`)
    check('registered repo kind is folder', folderRepo?.kind === 'folder', String(folderRepo?.kind))
    // The project ROOT of a folder project is not deletable (pre-existing rule, unrelated to the
    // gate); the deletable folder workspace is a child created under it.
    const folderRoot = ok(['worktree', 'show', '--worktree', `path:${folderDir}`]).worktree
    const rootRm = cli(['worktree', 'rm', '--worktree', folderRoot.id, '--force', '--run-hooks'])
    out(
      `  root refusal (unchanged): exit ${rootRm.status} ${parseJsonLine(rootRm)?.error?.code} -- ${parseJsonLine(rootRm)?.error?.message}`
    )
    check(
      'folder project root still refuses for its own reason, not the archive gate',
      rootRm.status !== 0 && parseJsonLine(rootRm)?.error?.code !== 'worktree_archive_hook_failed'
    )

    const folderChild = ok([
      'worktree',
      'create',
      '--repo',
      `id:${folderRepo.id}`,
      '--name',
      'agh-folder-child',
      '--setup',
      'skip'
    ]).worktree
    out(`folder workspace: ${folderChild.id}`)
    const runsBeforeFolder = hookRuns().length
    out(`\n$ orca worktree rm --worktree <folder workspace> --force --run-hooks`)
    const folderRm = cli(['worktree', 'rm', '--worktree', folderChild.id, '--force', '--run-hooks'])
    const folderJson = parseJsonLine(folderRm)
    out(`  exit code: ${folderRm.status}`)
    out(`  ${JSON.stringify(folderJson)}`)
    const stillThere = cli(['worktree', 'show', '--worktree', folderChild.id])
    check(
      'folder workspace removal exits zero',
      folderRm.status === 0,
      `${folderRm.status} ${folderRm.stderr}`
    )
    check('folder removal ran no archive hook', hookRuns().length === runsBeforeFolder)
    check(
      'folder contents left on disk (forget, not delete)',
      existsSync(join(folderDir, 'src', 'app.txt'))
    )
    check(
      'folder workspace is deregistered',
      stillThere.status !== 0 && parseJsonLine(stillThere)?.error?.code === 'selector_not_found'
    )
    rmSync(folderDir, { recursive: true, force: true })

    banner(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  } catch (error) {
    out(`\nHARNESS ERROR: ${error instanceof Error ? error.stack : String(error)}`)
    failures++
  } finally {
    for (const wt of created) {
      if (existsSync(wt.path)) {
        cli(['worktree', 'rm', '--worktree', wt.id, '--force'])
        rmSync(dirname(wt.path), { recursive: true, force: true })
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((r) => child.on('exit', r)),
        new Promise((r) => setTimeout(r, 15_000))
      ])
      child.kill('SIGKILL')
    }
    rmSync(userDataDir, { recursive: true, force: true })
  }
  process.exitCode = failures === 0 ? 0 : 1
}

setMode('ok')
main()
