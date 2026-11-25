import { describe, expect, it } from 'vitest'
import { resolveAgentBrowserPassthroughPaths } from './agent-browser-passthrough-paths'
import { splitAgentBrowserCommandLine } from './agent-browser-passthrough-arguments'

const resolve = (path: string): string => `/caller/${path}`

describe('resolveAgentBrowserPassthroughPaths', () => {
  it.each([
    [
      ['screenshot', 'shot.png'],
      ['screenshot', '/caller/shot.png']
    ],
    [
      ['screenshot', '#main'],
      ['screenshot', '#main']
    ],
    [
      ['screenshot', '#photo.png'],
      ['screenshot', '#photo.png']
    ],
    [
      ['screenshot', 'img.PNG'],
      ['screenshot', 'img.PNG']
    ],
    [
      ['screenshot', './shot'],
      ['screenshot', '/caller/./shot']
    ],
    [
      ['wait', '-d', 'r.pdf'],
      ['wait', '-d', '/caller/r.pdf']
    ],
    [
      ['screenshot', '../up.png'],
      ['screenshot', '/caller/../up.png']
    ],
    [
      ['record', 'start', '--contact-sheet-threshold', '0.2', 'v.webm'],
      ['record', 'start', '--contact-sheet-threshold', '0.2', '/caller/v.webm']
    ],
    [
      ['screenshot', '--full', '#main', 'x.png'],
      ['screenshot', '--full', '#main', '/caller/x.png']
    ],
    [
      ['pdf', '~/x.pdf'],
      ['pdf', '~/x.pdf']
    ],
    [
      ['download', '@e5', 'f.zip'],
      ['download', '@e5', '/caller/f.zip']
    ],
    [
      ['upload', '@e3', 'a.png', 'b.png'],
      ['upload', '@e3', '/caller/a.png', '/caller/b.png']
    ],
    [
      ['record', 'start', 'v.webm', 'https://x.test'],
      ['record', 'start', '/caller/v.webm', 'https://x.test']
    ],
    [
      ['network', 'har', 'stop', 'c.har'],
      ['network', 'har', 'stop', '/caller/c.har']
    ],
    [
      ['wait', '--download', 'd.bin'],
      ['wait', '--download', '/caller/d.bin']
    ],
    [
      ['fill', '@e1', './not-a-path'],
      ['fill', '@e1', './not-a-path']
    ]
  ])('%j', (args, expected) => {
    expect(resolveAgentBrowserPassthroughPaths(args, resolve)).toEqual(expected)
  })

  it('keeps a lone Windows screenshot path readable as a path', () => {
    const windowsResolve = (path: string): string => `C:\\work\\${path.slice(2)}`
    expect(resolveAgentBrowserPassthroughPaths(['screenshot', './shot'], windowsResolve)).toEqual([
      'screenshot',
      'C:/work/shot'
    ])
  })

  it('requotes only batch steps whose path changed, so agent-browser splits them back', () => {
    const [, changed, unchanged] = resolveAgentBrowserPassthroughPaths(
      ['batch', `pdf 'a "b".pdf'`, `fill @e1 'x y'`],
      (path) => `C:\\caller\\${path}`
    )
    expect(splitAgentBrowserCommandLine(changed!)).toEqual(['pdf', 'C:\\caller\\a "b".pdf'])
    expect(unchanged).toBe(`fill @e1 'x y'`)
  })
})
