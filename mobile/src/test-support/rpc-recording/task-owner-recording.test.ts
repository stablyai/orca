import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { runRecording } from './run-recording'
import { readScenarios } from './scenario-input'
import { materializeScenario } from './scenario-execution-mode'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import { ScriptedRpcTransport } from './scripted-rpc-transport'
import { captureValue } from './recording-values'
import type { Observation, Recording, RecordingScenario, ScenarioStep } from './recording-scenario'

const root = resolve(import.meta.dirname, '../../../..')
const { scenarios } = readScenarios(resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json'))

function pilot(id: string): RecordingScenario {
  const found = scenarios.find((scenario) => scenario.id === id)
  if (!found) {
    throw new Error(`Missing pilot: ${id}`)
  }
  return found
}

function observation(recording: Recording, id: string): Observation {
  const found = recording.checkpoints.find((checkpoint) => checkpoint.id === id)
  if (!found) {
    throw new Error(`Missing checkpoint: ${id}`)
  }
  return found.observation
}

function fieldValues(observed: Observation, field: string) {
  if (!Array.isArray(observed.effects)) {
    throw new Error('Effects must be an array')
  }
  return observed.effects.flatMap((effect) =>
    effect && typeof effect === 'object' && !Array.isArray(effect) && effect.name === field
      ? [effect.value]
      : []
  )
}

async function record(scenario: RecordingScenario) {
  const { adapters } = pilotMountAdapters(root, { device: scenario })
  const mount = adapters[scenario.operation]
  return runRecording(
    scenario,
    (context) => {
      const mounted = mount(context)
      return {
        ...mounted,
        action: (name, args) =>
          name === 'unmount' ? mounted.dispose() : mounted.action(name, args)
      }
    },
    vitestRecordingScheduler()
  )
}

describe('committed production task owners in recording adapters', () => {
  it.each(['tk-item-detail-gitlab', 'tk-project-row-detail'])(
    '%s uses an actual replacement client and suppresses the old client read',
    async (id) => {
      const base = pilot(id)
      const completion = base.steps.find((step) => 'complete' in step)
      if (!completion || !('complete' in completion)) {
        throw new Error('Missing read completion')
      }
      const clock = vitestRecordingScheduler()
      await clock.start()
      const original = new ScriptedRpcTransport(clock.elapsed)
      const replacement = new ScriptedRpcTransport(clock.elapsed)
      const effects: { name: string; value: ReturnType<typeof captureValue> }[] = []
      const { adapters } = pilotMountAdapters(root, { device: base })
      const mounted = adapters[base.operation]({
        client: original.client,
        effect: (name, value) => effects.push({ name, value: captureValue(value) })
      })
      try {
        mounted.action('mount', {})
        await clock.flush()
        expect(original.payloads).toHaveLength(1)
        mounted.action('replace-client', { client: replacement.client })
        await clock.flush()
        expect(replacement.payloads).toHaveLength(1)
        const pending = captureValue(mounted.state())
        const beforeOld = structuredClone(effects)
        original.complete(completion.complete, completion.params, completion.reply)
        await clock.flush()
        expect(captureValue(mounted.state())).toEqual(pending)
        expect(effects).toEqual(beforeOld)
        replacement.complete(completion.complete, completion.params, completion.reply)
        await clock.flush()
        if (id.includes('gitlab')) {
          // The real selection hydration effect owes exactly one successor read on the new client.
          expect(replacement.payloads).toHaveLength(2)
          replacement.complete('gitlab.workItemDetails#2', completion.params, completion.reply)
          await clock.flush()
        }
        expect(mounted.state()).toMatchObject({ loading: false, error: '' })
        expect(mounted.state()).toHaveProperty(
          id.includes('gitlab') ? 'payload.provider' : 'detail.provider',
          id.includes('gitlab') ? 'gitlab' : 'github'
        )
        expect(original.payloads).toHaveLength(1)
        for (const transport of [original, replacement]) {
          for (const request of transport.requests) {
            expect(request.settlement.status).toBe('fulfilled')
          }
        }
        const terminal = structuredClone(effects)
        mounted.action('update', {})
        await clock.flush()
        expect(effects).toEqual(terminal)
      } finally {
        mounted.dispose()
        original.dispose()
        replacement.dispose()
        await clock.flush()
        clock.stop()
      }
    }
  )

  it('does not commit product effects or dispatch from an abandoned detail render', async () => {
    const clock = vitestRecordingScheduler()
    await clock.start()
    const transport = new ScriptedRpcTransport(clock.elapsed)
    const effects: string[] = []
    const { adapters, assertMutationApplied } = pilotMountAdapters(root, {
      mutation: {
        name: 'abandon-before-commit',
        file: 'tasks/use-mobile-tasks-item-detail-loading.tsx',
        before: '  return model\n}',
        after: "  throw new Error('abandoned detail render')\n}"
      }
    })
    const mounted = adapters['tasks.item-detail-github']({
      client: transport.client,
      effect: (name) => effects.push(name)
    })
    try {
      expect(() => mounted.action('mount', {})).toThrow('abandoned detail render')
      await clock.flush()
      assertMutationApplied()
      expect(effects).toEqual([])
      expect(transport.requests).toEqual([])
      expect(transport.payloads).toEqual([])
    } finally {
      mounted.dispose()
      transport.dispose()
      await clock.flush()
      clock.stop()
    }
  })

  it.each([
    ['tk-item-metadata-gitlab', 'update-gitlab'],
    ['tk-item-comment-github', 'comment'],
    ['tk-item-checks-files', 'rerun'],
    ['tk-item-status-gitlab', 'gitlab-status'],
    ['tk-project-row-files-merge', 'pr-state'],
    ['tk-linear-item', 'comment']
  ])(
    '%s records deferred acquire, refused reentry, release and fresh remount',
    async (id, action) => {
      const base = pilot(id)
      const actionIndex = base.steps.findIndex((step) => 'action' in step && step.action === action)
      const completion = base.steps[actionIndex + 1]
      if (!completion || !('complete' in completion)) {
        throw new Error(`No completion: ${id}/${action}`)
      }
      const recording = await record({
        ...base,
        steps: [
          { action: 'mount', id: 'mount' },
          { checkpoint: 'baseline' },
          { action: 'update', id: 'unchanged' },
          { checkpoint: 'unchanged' },
          { action, id: 'first' },
          { checkpoint: 'pending' },
          { action, id: 'second-while-pending' },
          { checkpoint: 'still-pending' },
          completion,
          { checkpoint: 'terminal' },
          { action: 'update', id: 'terminal-update' },
          { checkpoint: 'terminal-unchanged' },
          { action: 'unmount', id: 'unmount' },
          { action: 'mount', id: 'remount' },
          ...(id === 'tk-linear-item'
            ? [{ action: 'edit-comment', id: 'fresh-draft', args: { body: 'a linear comment' } }]
            : []),
          { action, id: 'fresh' },
          { checkpoint: 'fresh-pending' },
          { ...completion, complete: completion.complete.replace('#1', '#2') },
          { checkpoint: 'fresh-terminal' }
        ]
      })
      const baseline = observation(recording, 'baseline')
      expect(observation(recording, 'unchanged').effects).toEqual(baseline.effects)
      expect(fieldValues(baseline, 'mutatingStatus')).toEqual([false])
      const pending = observation(recording, 'pending')
      expect(fieldValues(pending, 'mutatingStatus')).toEqual([false, true])
      expect(pending.payloads).toHaveLength(1)
      expect(pending.sender).toEqual([
        expect.objectContaining({
          name: completion.complete,
          settlement: { status: 'pending', startedAt: 0 }
        })
      ])
      expect(observation(recording, 'still-pending').payloads).toEqual(pending.payloads)
      expect(observation(recording, 'still-pending').effects).toEqual(pending.effects)
      const terminal = observation(recording, 'terminal')
      expect(fieldValues(terminal, 'mutatingStatus')).toEqual([false, true, false])
      expect(terminal.sender).toEqual([
        expect.objectContaining({ settlement: expect.objectContaining({ status: 'fulfilled' }) })
      ])
      expect(observation(recording, 'terminal-unchanged').effects).toEqual(terminal.effects)
      expect(fieldValues(observation(recording, 'fresh-pending'), 'mutatingStatus')).toEqual([
        false,
        true,
        false,
        false,
        true
      ])
      const fresh = observation(recording, 'fresh-terminal')
      expect(fresh.payloads).toHaveLength(2)
      expect(fieldValues(fresh, 'mutatingStatus')).toEqual([false, true, false, false, true, false])
    }
  )

  it.each(['false', 'throw'] as const)(
    'real %s settlement releases and admits a new action',
    async (mode) => {
      const base = pilot('tk-item-metadata-gitlab')
      const completion = base.steps.find((step) => 'complete' in step)
      if (!completion || !('complete' in completion)) {
        throw new Error('Missing metadata completion')
      }
      const failed: ScenarioStep =
        mode === 'false'
          ? { ...completion, reply: { ok: true, result: { ok: false, error: 'refused' } } }
          : {
              complete: completion.complete,
              params: completion.params,
              reject: { message: 'transport failed' }
            }
      const recording = await record({
        ...base,
        steps: [
          { action: 'mount', id: 'mount' },
          { action: 'update-gitlab', id: 'first' },
          { checkpoint: 'pending' },
          failed,
          { checkpoint: 'released' },
          { action: 'update-gitlab', id: 'fresh' },
          { ...completion, complete: 'gitlab.updateIssue#2' },
          { checkpoint: 'fresh' }
        ]
      })
      expect(fieldValues(observation(recording, 'released'), 'mutatingStatus')).toEqual([
        false,
        true,
        false
      ])
      expect(observation(recording, 'released').state).toMatchObject({
        error: mode === 'false' ? 'refused' : 'transport failed'
      })
      expect(observation(recording, 'fresh').payloads).toHaveLength(2)
      expect(fieldValues(observation(recording, 'fresh'), 'mutatingStatus')).toEqual([
        false,
        true,
        false,
        true,
        false
      ])
    }
  )

  it.each(['tk-item-checks-files', 'tk-project-row-files-merge'])(
    '%s records a same-path file successor and ignores retired publication/finish',
    async (id) => {
      const base = pilot(id)
      const completion = base.steps.find(
        (step) => 'complete' in step && step.complete === 'github.prFileContents#1'
      )
      if (!completion || !('complete' in completion)) {
        throw new Error('Missing file completion')
      }
      const recording = await record({
        ...base,
        steps: [
          { action: 'mount', id: 'mount' },
          { action: 'expand', id: 'old' },
          { bind: 'old-file', request: 'github.prFileContents#1', params: completion.params },
          { checkpoint: 'old-pending' },
          { action: 'expand', id: 'collapse' },
          { action: 'expand', id: 'successor' },
          { bind: 'fresh-file', request: 'github.prFileContents#2', params: completion.params },
          { checkpoint: 'successor-pending' },
          { ...completion, complete: 'old-file' },
          { checkpoint: 'old-settled' },
          {
            ...completion,
            complete: 'fresh-file',
            reply: {
              ok: true,
              result: {
                original: 'fresh base',
                modified: 'fresh head',
                originalIsBinary: false,
                modifiedIsBinary: false
              }
            }
          },
          { checkpoint: 'fresh-settled' }
        ]
      })
      expect(fieldValues(observation(recording, 'old-pending'), 'prFileLoadingPath')).toEqual([
        { $rpc: 'null' },
        'src/index.ts'
      ])
      const successor = observation(recording, 'successor-pending')
      expect(successor.payloads).toHaveLength(2)
      expect(fieldValues(successor, 'prFileContents')).toEqual([{}])
      expect(observation(recording, 'old-settled').effects).toEqual(successor.effects)
      const fresh = observation(recording, 'fresh-settled')
      expect(fieldValues(fresh, 'prFileLoadingPath')).toEqual([
        { $rpc: 'null' },
        'src/index.ts',
        { $rpc: 'null' }
      ])
      expect(fieldValues(fresh, 'prFileContents')).toEqual([
        {},
        {
          'src/index.ts': {
            original: 'fresh base',
            modified: 'fresh head',
            originalIsBinary: false,
            modifiedIsBinary: false
          }
        }
      ])
    }
  )

  it('observes the actual hidden metadata owner without unchanged effects or provider work', async () => {
    const base = pilot('tk-item-detail-metadata')
    const recording = await record({
      ...base,
      steps: [
        { action: 'mount', id: 'mount' },
        { checkpoint: 'baseline' },
        { action: 'update', id: 'unchanged' },
        { checkpoint: 'unchanged' }
      ]
    })
    const baseline = observation(recording, 'baseline')
    expect(fieldValues(baseline, 'itemBodyDraft')).toEqual(['', 'body'])
    expect(fieldValues(baseline, 'itemLabelsLoading')).toEqual([false])
    expect(baseline.sender).toEqual([])
    expect(baseline.payloads).toEqual([])
    expect(observation(recording, 'unchanged').effects).toEqual(baseline.effects)
  })

  it.each([
    ['tk-item-detail-github', 'payload', 'detailLoading'],
    ['tk-item-detail-gitlab', 'payload', 'detailLoading'],
    ['tk-item-detail-linear', 'payload', 'detailLoading'],
    ['tk-project-row-detail', 'detail', 'projectRowDetailLoading']
  ])(
    '%s retires a real pending read, reselects, refreshes and remounts',
    async (id, payloadField, loadingField) => {
      const base = materializeScenario(pilot(id), 'native')
      const completions = base.steps.filter((step) => 'complete' in step)
      // GitLab hydration commits a changed selected source, then the production effect reads it once more.
      const hydration = id === 'tk-item-detail-gitlab'
      const firstWave = hydration ? completions.slice(0, 1) : completions
      const counts = new Map<string, number>()
      function next(steps: typeof completions): ScenarioStep[] {
        return steps.map((step) => {
          const method = step.complete.split('#')[0]
          const count = (counts.get(method) ?? 0) + 1
          counts.set(method, count)
          return { ...step, complete: `${method}#${count}` }
        })
      }
      const nullSelection = id === 'tk-project-row-detail' ? { row: null } : { selected: null }
      const recording = await record({
        ...base,
        steps: [
          { action: 'mount', id: 'mount' },
          { checkpoint: 'pending' },
          { action: 'select', id: 'close', args: nullSelection },
          { checkpoint: 'closed' },
          ...next(firstWave),
          { checkpoint: 'late' },
          { action: 'select', id: 'reselect' },
          ...next(completions),
          { checkpoint: 'accepted' },
          { action: 'update', id: 'unchanged' },
          { checkpoint: 'unchanged' },
          { action: 'refresh', id: 'refresh' },
          { checkpoint: 'refresh-pending' },
          ...next(firstWave),
          { checkpoint: 'refreshed' },
          { action: 'unmount', id: 'unmount' },
          { action: 'mount', id: 'remount' },
          ...next(completions),
          { checkpoint: 'remounted' }
        ]
      })
      expect(fieldValues(observation(recording, 'pending'), loadingField)).toContain(true)
      const closed = observation(recording, 'closed')
      expect(closed.state).toMatchObject({ [payloadField]: { $rpc: 'null' }, loading: false })
      expect(observation(recording, 'late').state).toEqual(closed.state)
      for (const checkpoint of ['accepted', 'refreshed', 'remounted']) {
        expect(observation(recording, checkpoint).state).toMatchObject({
          [payloadField]: expect.objectContaining({
            provider: id.includes('gitlab') ? 'gitlab' : id.includes('linear') ? 'linear' : 'github'
          }),
          loading: false,
          error: ''
        })
      }
      if (id === 'tk-project-row-detail') {
        expect(fieldValues(observation(recording, 'accepted'), 'prFileContents')).toEqual([{}])
        expect(fieldValues(observation(recording, 'accepted'), 'prFileLoadingPath')).toEqual([
          { $rpc: 'null' }
        ])
        expect(fieldValues(observation(recording, 'accepted'), 'projectTitleDraft')).toContain(
          'Project issue'
        )
      } else {
        expect(fieldValues(observation(recording, 'accepted'), 'detailPayload')).toContainEqual(
          expect.objectContaining({
            provider: id.includes('gitlab') ? 'gitlab' : id.includes('linear') ? 'linear' : 'github'
          })
        )
      }
      expect(observation(recording, 'unchanged').effects).toEqual(
        observation(recording, 'accepted').effects
      )
      expect(observation(recording, 'refresh-pending').state).toMatchObject({ loading: true })
      // Every physical request has an actual reply; no owner proof relies on teardown rejecting a forgotten read.
      const terminal = observation(recording, 'remounted')
      if (!Array.isArray(terminal.sender)) {
        throw new Error('Sender must be an array')
      }
      expect(terminal.sender.length).toBe(
        [...counts.values()].reduce((sum, count) => sum + count, 0)
      )
      for (const request of terminal.sender) {
        expect(request).toMatchObject({ settlement: { status: 'fulfilled' } })
      }
    }
  )
})
