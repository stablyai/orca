import { describe, expect, it } from 'vitest'
import { refusedCommand } from './bot-automation-eval-refusals'

describe('commands the benchmark stand-in refuses', () => {
  it.each([
    [['skills', 'install', 'orchestration'], 'skills install'],
    [['--json', 'skills', 'install', 'orchestration'], 'skills install'],
    [['--json', 'serve', 'service', 'install'], 'serve'],
    [['--help', 'skills', 'update'], 'skills update'],
    [['--environment', 'box', 'skills', 'share', 'x'], 'skills share'],
    [['--pairing-code', 'abc', '--json', 'open'], 'open'],
    [['--environment=box', 'serve'], 'serve']
  ])('refuses %j', (argv, refused) => {
    expect(refusedCommand(argv)).toBe(refused)
  })

  it.each([
    [['automations', 'create', '--name', 'serve']],
    [['--json', 'skills', 'get', 'orchestration']],
    [['automations', 'trigger-options', '--json']]
  ])('lets %j through', (argv) => {
    expect(refusedCommand(argv)).toBeNull()
  })
})
