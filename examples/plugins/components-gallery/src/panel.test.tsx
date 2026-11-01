// Run with `orca plugin test .`: plain Node, no Orca window, the same runtime and checks Orca uses.
import { afterEach, assert, mount, test, type TestPanel } from 'orca/testing'
import * as gallery from './panel'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

test('fills in the form and saves once the checks pass', async () => {
  panel = await mount(gallery)
  assert.ok(panel.find({ role: 'alert' }) === null)
  assert.equal(panel.find({ role: 'button', text: 'Save' })?.disabled, true)

  await panel.type({ label: 'Title' }, 'Write docs')
  await panel.select({ label: 'Priority' }, 'high')
  await panel.slide({ label: 'Effort' }, 5)
  await panel.toggle({ label: 'I have read the guidelines' })
  await panel.press({ role: 'button', text: 'Save' })

  assert.ok(panel.find({ text: 'Saved Write docs' }))
  assert.equal(panel.valueOf({ label: 'Priority' }), 'high')
  assert.deepEqual(panel.persisted.plugin['gallery.title'], 'Write docs')
  assert.deepEqual(panel.errors, [])
})

test('pages, sorts and selects the Table, and loads Tree children lazily', async () => {
  panel = await mount(gallery)
  await panel.select({ type: 'Tabs' }, 'data')
  const table = { role: 'grid', label: 'Files' }
  assert.equal(panel.rowsOf(table).length, 50)

  await panel.loadMore(table)
  assert.equal(panel.rowsOf(table).length, 100)
  await panel.sort(table, 'size')
  assert.equal(panel.rowsOf(table).length, 50)
  await panel.selectRows(table, panel.rowsOf(table).slice(0, 2))
  assert.ok(panel.find({ text: /2 selected/ }))

  const tree = { role: 'tree' }
  assert.ok(!panel.find(tree)?.text.includes('main.ts'))
  await panel.expand(tree, 'src')
  assert.ok(panel.find(tree)?.text.includes('main.ts'))
  await panel.selectItem(tree, 'src/main.ts')
  assert.equal(panel.valueOf(tree), 'src/main.ts')
  assert.deepEqual(panel.errors, [])
})

test('draws the content tab without warnings', async () => {
  panel = await mount(gallery, { persisted: { plugin: { 'gallery.tab': 'content' } } })
  assert.ok(panel.find({ role: 'toolbar', label: 'Gallery actions' }))
  assert.ok(panel.find({ role: 'img', label: undefined }) !== null)
  assert.ok(panel.find({ role: 'document', text: /Components Gallery/ }))
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.errors, [])
})
