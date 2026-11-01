/**
 * Runs inside the plugin's Node process with the test hooks: for each components panel, and each
 * scenario its `<entry>.check.ts` defines (else one plain run), mount the worker (`main`) and the
 * panel on one mock host, so the panel's `plugin.request` reaches the worker as in Orca.
 */
export const PLUGIN_PANEL_CHECK_SCRIPT = `
const { mount, mockHost, mountWorker } = await import('orca/testing')
const { panels, main, scenario: only, drawnTree, listOnly } = JSON.parse(
  process.env.ORCA_PLUGIN_CHECK_PANELS
)
const results = []
let stray = []
process.on('unhandledRejection', (error) => stray.push(error))
const issueOf = (error, prefix = '') => ({
  kind: 'plugin',
  message: prefix + String(error?.message ?? error),
  stack: error?.stack
})
const refused = (refusals, prefix = '') =>
  refusals.map(({ method, code, message }) => prefix + 'host refused ' + method + ' (' + code + '): ' + message)
for (const { panel, entry, url, fixture } of panels) {
  let scenarios = { '': {} }
  const fixtureIssues = []
  if (fixture) {
    try {
      const loaded = await import(fixture.url)
      const defined = loaded.default ?? loaded.scenarios
      if (defined === null || typeof defined !== 'object' || Object.keys(defined).length === 0) {
        throw new Error(fixture.path + ' must export default (or \`scenarios\`) an object of named scenarios')
      }
      scenarios = defined
    } catch (error) {
      fixtureIssues.push(issueOf(error))
    }
  }
  if (listOnly) {
    // Names only: nothing is mounted, so nothing runs but the fixture module itself.
    results.push({ panel, entry, scenarios: fixture ? Object.keys(scenarios) : [], issues: fixtureIssues })
    continue
  }
  if (only !== undefined && !Object.hasOwn(scenarios, only)) {
    results.push({
      panel,
      entry,
      scenario: only,
      elements: 0,
      summary: [],
      issues: [...fixtureIssues, { kind: 'plugin', message: 'no check scenario named ' + JSON.stringify(only) + (fixture ? ' in ' + fixture.path : ': the panel has no .check file') }],
      warnings: []
    })
    continue
  }
  for (const [scenario, options] of Object.entries(scenarios)) {
    if (only !== undefined && scenario !== only) continue
    const result = { panel, entry, elements: 0, issues: [...fixtureIssues], warnings: [] }
    if (scenario) result.scenario = scenario
    stray = []
    const { persisted, theme, events, ...hostOptions } = options ?? {}
    const host = mockHost(hostOptions)
    let worker = null
    if (main) {
      try {
        worker = await mountWorker(await import(main.url), { host })
      } catch (error) {
        result.issues.push(issueOf(error, 'worker (' + main.path + '): '))
      }
    }
    try {
      const mounted = await mount(await import(url), { host, panelId: panel, persisted, theme })
      for (const { event, payload } of events ?? []) {
        await mounted.emit(event, payload)
      }
      result.elements = mounted.findAll({}).length
      result.summary = mounted.summary()
      result.tree = mounted.tree()
      if (drawnTree) result.drawnTree = mounted.drawnTree()
      result.issues.push(...mounted.errors)
      result.warnings.push(...mounted.warnings)
      // Refused even when the code caught it: in Orca the call fails the same way.
      result.warnings.push(...refused(mounted.refusals))
      await mounted.unmount()
    } catch (error) {
      stray.push(error)
    }
    try {
      await worker?.deactivate()
    } catch (error) {
      result.issues.push(issueOf(error, 'worker (' + main.path + '): '))
    }
    for (const error of stray) {
      result.issues.push(issueOf(error))
    }
    results.push(result)
  }
}
process.stdout.write('\\n__ORCA_CHECK__' + JSON.stringify(results))
`
