import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it, vi } from 'vitest'

it.skipIf(process.platform === 'win32')(
  'runs the real Python BROWSER parser with a colon, space and apostrophe in the executable path',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agy-browser-parser-'))
    const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!
    const executable = join(root, "node: space 'quote")
    await symlink(process.execPath, executable)
    try {
      Object.defineProperty(process, 'execPath', { ...descriptor, value: executable })
      vi.resetModules()
      const helper = await import('./antigravity-browser-helper')
      Object.defineProperty(process, 'execPath', descriptor)
      const link = "https://example.invalid/auth?state=colon:space%20quote'&code=fixture"
      // Only the supplied BROWSER entry is registered; a failure cannot open a real browser.
      const script = `import os, sys, webbrowser
register = webbrowser.register
allowed = os.environ['BROWSER'].split(os.pathsep)
def restricted(name, klass, instance=None, *, preferred=False):
    if name in allowed:
        register(name, klass, instance, preferred=preferred)
webbrowser.register = restricted
webbrowser.register_standard_browsers()
assert webbrowser._tryorder == allowed, webbrowser._tryorder
assert webbrowser.open(sys.argv[1])
`
      expect(helper.ANTIGRAVITY_BROWSER_COMMAND).not.toContain(':')
      const result = await runProcess({
        program: 'python3',
        args: ['-c', script, link],
        env: { BROWSER: helper.ANTIGRAVITY_BROWSER_COMMAND },
        timeoutMs: 5_000,
        maxOutputBytes: 4_096
      })
      expect(result).toMatchObject({
        code: 0,
        stdout: '',
        stderr: `${helper.ANTIGRAVITY_BROWSER_MARKER}${JSON.stringify(link)}\n`
      })
      expect(await helper.antigravityBrowserHelperWorks()).toBe(true)
    } finally {
      Object.defineProperty(process, 'execPath', descriptor)
      await rm(root, { recursive: true, force: true })
      vi.resetModules()
    }
  }
)
