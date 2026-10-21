import { readFileSync, writeFileSync } from 'node:fs'

// Executable fake gcloud: revision deletion obeys the platform's latest/traffic constraints.
const path = process.env.MODEL_STATE
const state = JSON.parse(readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const has = (name) => args.includes(name)
const fail = (message) => {
  throw new Error(message)
}
const persist = () => writeFileSync(path, JSON.stringify(state))
const output = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value))
const revision = (name) => state.revisions[name] ?? fail(`missing revision ${name}`)
const traffic = () => [
  { revisionName: state.serving, percent: 100 },
  ...Object.entries(state.tags).map(([tag, name]) => ({
    tag,
    revisionName: name,
    url: `https://${tag}.test`
  }))
]
state.trace.push(args.join(' '))
try {
  if (args[0] === 'curl') {
    if (state.failure === 'public' && args.some((arg) => arg.includes('https://public.test'))) {
      fail('public check failed')
    }
    const url = args.find((arg) => arg.startsWith('https://'))
    const tag = new URL(url).hostname.split('.')[0]
    const name = state.tags[tag] ?? state.serving
    if (has('-w')) {
      output('200')
    } else {
      output({
        ok: true,
        deliveryProtocol: 2,
        mode: revision(name).spec.containers[0].env.some((entry) => entry.value === 'validation')
          ? 'validation'
          : 'active'
      })
    }
  } else if (args.slice(0, 2).join(' ') === 'run deploy') {
    const name = `${option('deploy')}-${option('--revision-suffix')}`
    if (state.failure === 'deploy-before') {
      fail('deploy failed before create')
    }
    const item = structuredClone(revision(state.latest))
    item.metadata.name = name
    item.spec.containers[0].image = option('--image')
    item.status.imageDigest = option('--image')
    item.spec.containers[0].env = item.spec.containers[0].env.filter(
      (entry) => entry.name !== 'ORCA_PUSH_MODE'
    )
    if (has('--update-env-vars')) {
      item.spec.containers[0].env.push({ name: 'ORCA_PUSH_MODE', value: 'validation' })
    }
    state.revisions[name] = item
    state.latest = name
    if (has('--tag')) {
      state.tags[option('--tag')] = name
    }
    state.peak = Math.max(state.peak, Object.keys(state.revisions).length)
    if (state.peak > 3) {
      fail('three-revision budget exceeded')
    }
    if (state.failure === 'deploy-after') {
      fail('deploy failed after create')
    }
  } else if (args.slice(0, 3).join(' ') === 'run services describe') {
    if (state.failure === 'describe') {
      fail('describe failed')
    }
    if (args.some((arg) => arg.includes('value(status.latestCreatedRevisionName)'))) {
      output(state.latest)
    } else {
      const template = structuredClone(revision(state.latest))
      delete template.spec.containers[0].name
      output({
        spec: { template },
        status: { latestCreatedRevisionName: state.latest, traffic: traffic() }
      })
    }
  } else if (args.slice(0, 3).join(' ') === 'run services update-traffic') {
    if (has('--to-revisions')) {
      const name = option('--to-revisions').split('=')[0]
      revision(name)
      state.serving = name
    }
    if (has('--remove-tags')) {
      for (const tag of option('--remove-tags').split(',')) {
        delete state.tags[tag]
      }
    }
    if (has('--clear-tags')) {
      state.tags = {}
    }
    if (state.failure === 'traffic-after') {
      fail('traffic changed but response failed')
    }
  } else if (args.slice(0, 3).join(' ') === 'run revisions list') {
    const names = Object.keys(state.revisions)
    output(
      (has('--filter')
        ? names.filter((name) => name === option('--filter').split('=')[1])
        : names
      ).join('\n')
    )
  } else if (args.slice(0, 3).join(' ') === 'run revisions describe') {
    const item = revision(args[3])
    const format = args.find((arg) => arg.startsWith('--format=')) ?? option('--format')
    if (format.includes('minScale')) {
      output(item.metadata.annotations['autoscaling.knative.dev/minScale'])
    } else if (format.includes('maxScale')) {
      output(item.metadata.annotations['autoscaling.knative.dev/maxScale'])
    } else {
      output(item)
    }
  } else if (args.slice(0, 3).join(' ') === 'run revisions delete') {
    const name = args[3]
    if (name === state.latest) {
      fail('FAILED_PRECONDITION: latest created Revision cannot be directly deleted')
    }
    if (name === state.serving || Object.values(state.tags).includes(name)) {
      fail('revision has traffic or tags')
    }
    if (state.failure === 'delete') {
      fail('delete failed')
    }
    revision(name)
    delete state.revisions[name]
  } else {
    fail(`unmodeled gcloud call ${args.join(' ')}`)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  persist()
}
