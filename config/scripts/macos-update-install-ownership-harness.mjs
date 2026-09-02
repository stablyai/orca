#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const QUERY_SCRIPT = `
function run(argv) {
  ObjC.import('AppKit')
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0])
  const pids = []
  for (let index = 0; index < apps.count; index += 1) {
    pids.push(Number(apps.objectAtIndex(index).processIdentifier))
  }
  return JSON.stringify(pids)
}`

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ skipped: true, reason: 'macOS-only AppKit boundary' }))
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), 'orca-update-owner-'))
const bundleId = `com.stablyai.orca.update-owner-harness.${process.pid}`
const appBundle = join(root, 'Orca Update Owner Harness.app')
const helperBundleId = `${bundleId}.helper`
const helperBundle = join(appBundle, 'Contents', 'Frameworks', 'Orca Helper.app')
const launchedPids = new Map()

try {
  await createLoopingAppBundle(appBundle, bundleId, 'OwnershipHarness')
  await createLoopingAppBundle(helperBundle, helperBundleId, 'Orca Helper')

  await execFileAsync('/usr/bin/open', ['-n', appBundle])
  const first = await waitForOwnerCount(bundleId, 1)
  first.forEach((pid) => launchedPids.set(pid, appBundle))
  await execFileAsync('/usr/bin/open', ['-n', helperBundle])
  const helper = await waitForOwnerCount(helperBundleId, 1)
  helper.forEach((pid) => launchedPids.set(pid, helperBundle))
  await execFileAsync('/usr/bin/open', ['-n', appBundle])
  const second = await waitForOwnerCount(bundleId, 2)
  second.forEach((pid) => launchedPids.set(pid, appBundle))

  if (first.length !== 1 || second.length !== 2 || second.includes(helper[0])) {
    throw new Error('AppKit ownership classification did not match the expected 1→2 desktop count')
  }
  console.log(
    JSON.stringify({
      skipped: false,
      bundleId,
      desktopCounts: [first.length, second.length],
      helperPid: helper[0],
      helperCounted: second.includes(helper[0])
    })
  )
} finally {
  for (const [pid, expectedCommandFragment] of launchedPids) {
    await stopOwnedProcess(pid, expectedCommandFragment)
  }
  await rm(root, { recursive: true, force: true })
}

async function createLoopingAppBundle(bundlePath, bundleIdentifier, executableName) {
  const executable = join(bundlePath, 'Contents', 'MacOS', executableName)
  await mkdir(join(bundlePath, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(
    join(bundlePath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
<key>CFBundleExecutable</key><string>${executableName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
</dict></plist>\n`
  )
  await writeFile(
    executable,
    `#!/bin/sh
trap 'kill "$child_pid" 2>/dev/null; exit 0' TERM INT
while :; do
  sleep 30 &
  child_pid=$!
  wait "$child_pid"
done
`
  )
  await chmod(executable, 0o755)
}

async function queryOwnerPids(bundleIdentifier) {
  const { stdout } = await execFileAsync('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    QUERY_SCRIPT,
    bundleIdentifier
  ])
  return JSON.parse(stdout.trim())
}

async function waitForOwnerCount(bundleIdentifier, expectedCount) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pids = await queryOwnerPids(bundleIdentifier)
    if (pids.length === expectedCount) {
      return pids
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`timed out waiting for ${expectedCount} AppKit owner(s)`)
}

async function stopOwnedProcess(pid, expectedCommandFragment) {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command='])
    if (!stdout.includes(expectedCommandFragment)) {
      throw new Error(`refusing to stop unverified pid ${pid}`)
    }
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 1 && error?.code !== 'ESRCH') {
      throw error
    }
  }
}
