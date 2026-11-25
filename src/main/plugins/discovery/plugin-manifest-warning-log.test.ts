import { expect, it, vi } from 'vitest'
import { createPluginManifestWarningLog } from './plugin-manifest-warning-log'

it('logs a folder warnings once, and again only after they change', () => {
  const warn = vi.fn()
  const log = createPluginManifestWarningLog(warn)
  log('/plugins/acme', 'acme/db', ['icon A', 'icon A', 'icon B'])
  expect(warn.mock.calls).toEqual([['[plugins] acme/db: icon A'], ['[plugins] acme/db: icon B']])

  // A refresh that re-reads the same manifest stays quiet.
  log('/plugins/acme', 'acme/db', ['icon A', 'icon A', 'icon B'])
  expect(warn).toHaveBeenCalledTimes(2)

  log('/plugins/acme', 'acme/db', ['icon C'])
  expect(warn).toHaveBeenLastCalledWith('[plugins] acme/db: icon C')
  expect(warn).toHaveBeenCalledTimes(3)

  // Fixed, then broken again: the author sees the warning again.
  log('/plugins/acme', 'acme/db', [])
  log('/plugins/acme', 'acme/db', ['icon C'])
  expect(warn).toHaveBeenCalledTimes(4)
})

it('keeps folders apart', () => {
  const warn = vi.fn()
  const log = createPluginManifestWarningLog(warn)
  log('/plugins/acme/1.0.0', 'acme/db', ['icon A'])
  log('/plugins/acme/1.0.1', 'acme/db', ['icon A'])
  log('/plugins/acme/1.0.0', 'acme/db', ['icon A'])
  expect(warn).toHaveBeenCalledTimes(2)
})
