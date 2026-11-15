import { describe, expect, it } from 'vitest'
import { publishSteps, shellLine } from './theme-publish-steps'

describe('shellLine', () => {
  it('leaves plain words bare and single-quotes the rest, so pasted lines never expand', () => {
    expect(shellLine(['git', '-C', '/tmp/a b', 'commit', '-m', 'Publish $(rm -rf ~) `x`'])).toBe(
      "git -C '/tmp/a b' commit -m 'Publish $(rm -rf ~) `x`'"
    )
    expect(shellLine(["it's"])).toBe("'it'\\''s'")
  })
})

describe('publishSteps', () => {
  const steps = publishSteps({
    folder: '/home/me/orca-themes/ember',
    slug: 'octocat/ember-orca-theme',
    name: 'Ember',
    version: '1.2.0',
    files: ['orca-plugin.json', 'images']
  })

  it('points every git command at the folder, so a printed step runs in the right place', () => {
    for (const step of steps) {
      for (const command of [step.command, step.skipIf, step.otherwise]) {
        if (command?.[0] === 'git') {
          expect(command.slice(1, 3)).toEqual(['-C', '/home/me/orca-themes/ember'])
        }
      }
    }
  })

  it('stages only the files it wrote', () => {
    const add = steps.find((step) => step.label === 'Add the files')
    expect(add?.command.slice(-3)).toEqual(['--', 'orca-plugin.json', 'images'])
  })

  it('pushes to an existing repository instead of creating it again', () => {
    const create = steps.find((step) => step.command[1] === 'repo' && step.command[2] === 'create')
    expect(create?.skipIf?.slice(0, 3)).toEqual(['gh', 'repo', 'view'])
    expect(create?.otherwise).toEqual([
      'git',
      '-C',
      '/home/me/orca-themes/ember',
      'push',
      '-u',
      'origin',
      'HEAD'
    ])
  })
})
