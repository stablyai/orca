import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectCommanderBriefing } from './commander-briefing.mjs'

test('reports decisions and progress across run pages while preserving incomplete host reads', async () => {
  const inventory = {
    hosts: [
      { kind: 'local', id: 'local', name: 'Laptop' },
      { kind: 'environment', id: 'build', name: 'Build server' },
      { kind: 'ssh', id: 'ssh1', name: 'SSH folder' }
    ]
  }
  const query = async ([group, command, ...flags]) => {
    if (group === 'host') {
      return inventory
    }
    if (flags.at(-1) === 'build') {
      throw new Error('server asleep')
    }
    if (group === 'project') {
      return { setups: [{ projectId: 'github:acme/api', hostId: 'local', setupState: 'ready' }] }
    }
    if (command === 'run-list') {
      return flags.includes('--cursor')
        ? { runs: [{ id: 'b', objective: 'Ship client' }] }
        : { runs: [{ id: 'a', objective: 'Ship API' }], nextCursor: 'page2' }
    }
    if (command === 'task-list') {
      return {
        tasks: flags.includes('a')
          ? [{ status: 'ready' }, { status: 'ready' }, { status: 'blocked' }]
          : []
      }
    }
    if (command === 'gate-list' && flags.includes('pending')) {
      return {
        gates: flags.includes('a') ? [{ id: 'gate1', taskId: 't', question: 'Ship today?' }] : []
      }
    }
    throw new Error('Unexpected command')
  }
  assert.deepEqual(await collectCommanderBriefing({}, query), {
    hosts: [
      {
        id: 'local',
        name: 'Laptop',
        projects: [{ projectId: 'github:acme/api', hostId: 'local', state: 'ready' }],
        goals: [
          {
            id: 'a',
            objective: 'Ship API',
            tasks: { ready: 2, blocked: 1 },
            decisions: [{ id: 'gate1', taskId: 't', question: 'Ship today?' }]
          },
          { id: 'b', objective: 'Ship client', tasks: {}, decisions: [] }
        ]
      },
      { id: 'build', name: 'Build server', projects: null, goals: [] }
    ],
    issues: [
      { environment: 'build', scope: 'projects', message: 'server asleep' },
      { environment: 'build', scope: 'goals', message: 'server asleep' }
    ]
  })
})
