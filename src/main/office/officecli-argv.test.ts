import { describe, expect, it } from 'vitest'
import {
  officecliGotoArgs,
  officecliMarksArgs,
  officecliRenderArgs,
  officecliSelectionArgs,
  officecliSkillsInstallArgs,
  officecliSkillsListArgs,
  officecliSwitchRequest,
  officecliUnmarkAllArgs,
  officecliWatchStartArgs,
  officecliWatchStopArgs
} from './officecli-argv'

describe('officecli argument vectors', () => {
  it('keeps a POSIX path with spaces and shell metacharacters as one argument', () => {
    const path = "/w/My Docs/report $(whoami) 'q'.docx"
    expect(officecliRenderArgs(path, '/tmp/out.html')).toEqual([
      'view',
      path,
      'html',
      '-o',
      '/tmp/out.html',
      '--json'
    ])
  })

  it('keeps a Windows path intact', () => {
    const path = 'C:\\Users\\me\\Deck & Co.pptx'
    expect(officecliWatchStartArgs(path, 26399)).toEqual(['watch', path, '--port', '26399'])
    expect(officecliWatchStopArgs(path)).toEqual(['unwatch', path])
  })

  it('builds the watch subcommand forms the tool actually accepts', () => {
    expect(officecliMarksArgs('/w/a.pptx')).toEqual(['watch', 'marks', '/w/a.pptx', '--json'])
    expect(officecliUnmarkAllArgs('/w/a.pptx')).toEqual(['watch', 'unmark', '/w/a.pptx', '--all'])
    expect(officecliGotoArgs('/w/a.pptx', '/slide[1]')).toEqual([
      'watch',
      'goto',
      '/w/a.pptx',
      '/slide[1]'
    ])
    expect(officecliSelectionArgs('/w/a.pptx')).toEqual(['get', '/w/a.pptx', 'selected', '--json'])
  })

  it('asks the switch endpoint for a re-render with the field the tool requires', () => {
    // `path` answers 400 "missing required field: file" — verified against 1.0.148.
    const request = officecliSwitchRequest(26399, '/w/a.pptx')
    expect(request.url).toBe('http://127.0.0.1:26399/api/switch')
    expect(JSON.parse(request.body)).toEqual({ file: '/w/a.pptx' })
  })

  it('builds the skills calls', () => {
    expect(officecliSkillsListArgs()).toEqual(['skills', 'list'])
    expect(officecliSkillsInstallArgs('pptx', 'claude')).toEqual([
      'skills',
      'install',
      'pptx',
      'claude'
    ])
  })
})
