// Why: detached `git gc --auto`/maintenance jobs keep writing .git/objects
// while afterEach removes fixture dirs (ENOTEMPTY). GIT_CONFIG_* env overrides
// repo/global config for every spawned git process, so they never start.
const entries: [string, string][] = [
  ['gc.auto', '0'],
  ['gc.autoDetach', 'false'],
  ['maintenance.auto', 'false']
]

const base = Number(process.env.GIT_CONFIG_COUNT ?? 0)
entries.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${base + index}`] = key
  process.env[`GIT_CONFIG_VALUE_${base + index}`] = value
})
process.env.GIT_CONFIG_COUNT = String(base + entries.length)

// Why: a developer-machine `trace2.eventTarget` (e.g. a git-ai daemon) makes
// an external process react to fixture commits and write AI notes into the
// fixture's .git while teardown removes it. Env overrides the config target.
process.env.GIT_TRACE2_EVENT = '0'

export {}
