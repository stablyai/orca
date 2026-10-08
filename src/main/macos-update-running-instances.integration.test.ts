import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../shared/child-process/run-process'
import { getMacUpdateRunningInstances } from './macos-update-running-instances'

const APPLICATION_SOURCE = `
#import <AppKit/AppKit.h>
#import <unistd.h>
int main(int argc, const char *argv[]) {
  if (argc > 1) { sleep(30); return 0; }
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [app run];
  }
  return 0;
}
`

it.runIf(process.platform === 'darwin')(
  'matches ShipIt with registered sibling apps, excluding same-executable workers and other bundle copies',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-update-instances-'))
    const bundle = path.join(root, 'Orca Test.app')
    const executable = path.join(bundle, 'Contents', 'MacOS', 'Orca Test')
    mkdirSync(path.dirname(executable), { recursive: true })
    const sourcePath = path.join(root, 'application.m')
    writeFileSync(sourcePath, APPLICATION_SOURCE)
    writeFileSync(
      path.join(bundle, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
        <key>CFBundleIdentifier</key><string>com.stablyai.${path.basename(root)}</string>
        <key>CFBundleExecutable</key><string>Orca Test</string>
        <key>CFBundlePackageType</key><string>APPL</string>
      </dict></plist>`
    )
    const children: ReturnType<typeof spawnProcess>[] = []
    const closed: Promise<unknown>[] = []
    try {
      const compilation = await runProcess({
        program: '/usr/bin/clang',
        args: ['-framework', 'AppKit', sourcePath, '-o', executable],
        timeoutMs: 15_000
      })
      expect(compilation.code, compilation.stderr).toBe(0)
      const otherBundle = path.join(root, 'Other Orca.app')
      cpSync(bundle, otherBundle, { recursive: true })
      for (const [program, args] of [
        [executable, []],
        [executable, []],
        [executable, ['--worker']],
        [path.join(otherBundle, 'Contents', 'MacOS', 'Orca Test'), []]
      ] satisfies [string, string[]][]) {
        const child = spawnProcess({
          program,
          args,
          env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
        })
        children.push(child)
        closed.push(once(child, 'close'))
      }
      const [self, sibling, worker, otherCopy] = children
      await vi.waitFor(
        async () => {
          expect(self.pid).toBeTypeOf('number')
          expect(sibling.pid).toBeTypeOf('number')
          expect(await getMacUpdateRunningInstances(executable, self.pid)).toEqual([sibling.pid])
          expect(
            await getMacUpdateRunningInstances(
              path.join(otherBundle, 'Contents', 'MacOS', 'Orca Test'),
              0
            )
          ).toEqual([otherCopy.pid])
          const workerListing = await runProcess({
            program: '/bin/ps',
            args: ['-p', String(worker.pid), '-ww', '-o', 'comm=']
          })
          expect(workerListing.stdout.trim()).toBe(executable)
        },
        { timeout: 5000 }
      )
      sibling.kill('SIGTERM')
      await closed[1]
      expect(await getMacUpdateRunningInstances(executable, self.pid)).toEqual([])
    } finally {
      for (const child of children) {
        child.kill('SIGTERM')
      }
      await Promise.all(closed)
      rmSync(root, { recursive: true, force: true })
    }
  },
  25_000
)
