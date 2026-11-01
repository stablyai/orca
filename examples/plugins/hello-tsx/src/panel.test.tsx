// Run with `orca plugin test .`: plain Node, no Orca window, the same runtime and checks Orca uses.
import { afterEach, assert, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

test('adds a task from the input and counts it as open', async () => {
  panel = await mount(panelModule)
  assert.equal(panel.find({ role: 'status' })?.text, '1 open')

  await panel.type({ label: 'New task' }, 'Write a test', { submit: true })

  assert.ok(panel.find({ role: 'button', text: /Write a test/ }))
  assert.equal(panel.find({ role: 'status' })?.text, '2 open')
  // Enter submitted and the panel cleared the field.
  assert.equal(panel.valueOf({ label: 'New task' }), '')
  // The list is a persisted atom: this is what the next run starts from.
  const stored = panel.persisted.plugin.todos
  assert.ok(Array.isArray(stored))
  assert.equal(stored.length, 3)
  assert.deepEqual(panel.errors, [])
})

test('starts from the persisted list and clears done tasks', async () => {
  panel = await mount(panelModule, {
    persisted: { plugin: { todos: [{ id: 7, title: 'Ship it', done: true }] } }
  })
  assert.equal(panel.find({ role: 'status' })?.text, '0 open')

  await panel.press({ text: 'Clear done' })

  assert.ok(panel.find({ label: 'Nothing to do' }))
})
