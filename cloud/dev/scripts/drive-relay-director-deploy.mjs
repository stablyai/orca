// Operator-local driver for a production relay director deploy. It only dispatches the existing
// audited workflows and reads their results back; every safety check stays in those workflows.
//
// It keeps no state between runs. Every decision comes from live state read at the start: the
// serving director, its configured cells, and the rehome control. The one fact live state cannot
// show, that a pause is this driver's own, is the run that made it (`--pause-run`), checked
// against that run's log and the live generation. On any stop it prints the command that
// finishes the deploy from wherever it got to.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { verifyDryRunAuthority } from './relay-monitor-evidence.mjs'
import {
  DIRECTOR_SERVICE,
  IMAGE_REPOSITORY,
  PROJECT,
  REGION,
  REPOSITORY,
  WORKFLOW_REF,
  WORKFLOWS,
  admissionInspectInputs,
  admissionInspectResult,
  blocksDeploy,
  configureInputs,
  directorDeployInputs,
  directorRevisions,
  logConfirmsPublishedDigest,
  monitorDryRunInputs,
  parseConfigureWave,
  pausedGeneration,
  publishInputs,
  rehomeEnableInputs,
  rehomeInspectInputs,
  rehomePauseInputs,
  rehomeResultFromLog,
  requireCommit,
  requireDigest,
  revisionDigest,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'

const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending']
// The enable job verifies the monitor within 5 minutes of completion after ~2.5 minutes of setup.
export const MONITOR_MAX_AGE_AT_ENABLE_MS = 150_000
// The manual procedure watched the new director for 5+ minutes before configuring cells.
export const SOAK_MS = 5 * 60_000
// Traffic moves about a minute before the deploy run completes (ops-log 05:00:33Z vs 05:01:34Z).
const TRAFFIC_SWITCH_LEAD_MS = 60_000
// Request logs land up to a minute late; reading at the window's end would undercount it.
const LOG_INGESTION_LAG_MS = 60_000
const DIRECTOR_5XX_FILTER = [
  'resource.type="cloud_run_revision"',
  `resource.labels.service_name="${DIRECTOR_SERVICE}"`,
  `logName="projects/${PROJECT}/logs/run.googleapis.com%2Frequests"`,
  'httpRequest.status>=500'
].join(' AND ')
const LOG_COUNT_LIMIT = 5_000
const LOG_ATTEMPTS = 6
const LOG_INTERVAL_MS = 10_000
const WATCH_INTERVAL_MS = 10_000
// A run still going is reported this often, so a long monitor never looks hung.
const WATCH_REPORT_MS = 5 * 60_000
const REHOME_HISTORY_RUNS = 5
const RUN_ID = /^[1-9][0-9]*$/

export class DriverStop extends Error {}

export function parseDriverArguments(argv, home = homedir()) {
  const config = {
    dryRun: false,
    leaveRehomePaused: false,
    configure: [],
    logDirectory: join(home, '.orca', 'relay-director-deploy')
  }
  const runId = (value, key) => {
    if (!RUN_ID.test(value)) throw new Error(`${key} must be a run ID`)
    return Number(value)
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--dry-run' || key === '--leave-rehome-paused') {
      config[key === '--dry-run' ? 'dryRun' : 'leaveRehomePaused'] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`)
    index += 1
    if (key === '--commit') config.commit = requireCommit(value, '--commit')
    else if (key === '--configure') config.configure.push(parseConfigureWave(value))
    else if (key === '--publish-run') config.publishRun = runId(value, key)
    else if (key === '--pause-run') config.pauseRun = runId(value, key)
    else if (key === '--rehome-generation') {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('--rehome-generation is invalid')
      config.rehomeGeneration = Number(value)
    } else if (key === '--log-directory') config.logDirectory = resolve(value)
    else throw new Error(`unsupported argument ${key}`)
  }
  if (!config.commit) throw new Error('missing --commit <40-character main commit to publish>')
  if (config.pauseRun && config.leaveRehomePaused) {
    throw new Error('--pause-run and --leave-rehome-paused contradict each other')
  }
  return config
}

const timestamp = (ms) => new Date(ms).toISOString()
const runUrl = (runId) => `https://github.com/${REPOSITORY}/actions/runs/${runId}`
// Argument lists whose values never contain spaces.
const words = (text) => text.split(' ')

export function createDriver(config, deps) {
  let logPath
  const typedPhrases = new Map()
  // Everything learned this run; nothing outlives the process.
  const known = { director: undefined, selector: undefined, control: undefined }
  let rollbackPoint
  let published = config.publishRun ? { runId: config.publishRun } : undefined
  let owned // { generation, runId }: the pause this driver made, the only rehome state it owns
  // A pause or enable this run cannot vouch for: `changing` while it may still apply on its own,
  // `unconfirmed` once it finished without a usable result. { kind, name, runId?, url? }
  let uncertain
  let movedBuild // { commit, runId }: a publish that built a newer main than the reviewed commit
  let login
  const ownRunIds = new Set()
  let enabled = false

  function log(message) {
    const line = `${timestamp(deps.now())} ${message}`
    deps.print(line)
    if (logPath) appendFileSync(logPath, `${line}\n`)
  }

  function command(program, args, input) {
    const result = deps.run(program, args, input)
    if (result.status !== 0) {
      const detail = String(result.stderr ?? '')
        .trim()
        .split('\n')
        .slice(-3)
        .join(' | ')
      throw new Error(`${program} ${args.slice(0, 4).join(' ')} failed: ${detail}`)
    }
    return String(result.stdout ?? '')
  }

  const gh = (args, input) => command('gh', args, input)
  const ghJson = (args) => JSON.parse(gh(args))
  const gcloudJson = (args) =>
    JSON.parse(command('gcloud', [...args, '--project', PROJECT, '--format=json']))

  function readDirector() {
    const service = gcloudJson(
      words(`run services describe ${DIRECTOR_SERVICE} --region ${REGION}`)
    )
    const { servingRevision, rollbackRevision } = directorRevisions(service)
    const describe = (revision) =>
      gcloudJson(words(`run revisions describe ${revision} --region ${REGION}`))
    const serving = describe(servingRevision)
    const cellsJson = serving.spec.containers[0].env?.find(
      (variable) => variable.name === 'ORCA_RELAY_CELLS_JSON'
    )?.value
    return {
      servingRevision,
      servingDigest: revisionDigest(serving, `revision ${servingRevision}`),
      servingCreatedAt: serving.metadata?.creationTimestamp,
      cells: new Set(JSON.parse(cellsJson ?? '[]').map((cell) => cell.id)),
      rollbackRevision,
      rollbackDigest: revisionDigest(describe(rollbackRevision), `revision ${rollbackRevision}`)
    }
  }

  function describeDirector(director) {
    return `serving ${director.servingRevision} ${director.servingDigest}; rollback ${director.rollbackRevision} ${director.rollbackDigest}`
  }

  // Paginated per status: the repository-wide first page can hide an in-flight relay run.
  function activeRuns() {
    const active = []
    for (const status of ACTIVE_RUN_STATUSES) {
      const lines = gh(
        words(
          `api --paginate -X GET repos/${REPOSITORY}/actions/runs -f status=${status} -f per_page=100 --jq .workflow_runs[]|{id,path,name,status}`
        )
      )
      for (const run of lines.split('\n').filter(Boolean).map(JSON.parse)) {
        if (blocksDeploy(run.path) && !ownRunIds.has(run.id))
          active.push(`${run.name} ${runUrl(run.id)} (${run.status})`)
      }
    }
    return active
  }

  function requireQuietLane() {
    const active = activeRuns()
    if (active.length > 0) {
      throw new DriverStop(
        `relay workflows are in flight; wait for them:\n  ${active.join('\n  ')}`
      )
    }
  }

  function viewRun(runId) {
    return ghJson(
      words(
        `run view ${runId} -R ${REPOSITORY} --json status,conclusion,attempt,headSha,headBranch,event,workflowName`
      )
    )
  }

  // One line per status change and one every WATCH_REPORT_MS, never a stream of job steps.
  async function waitForRun(run) {
    const started = deps.now()
    let reported
    let reportedAt
    for (;;) {
      const view = viewRun(run.runId)
      if (view.status === 'completed') {
        log(`${run.name}: ${view.conclusion} ${run.url}`)
        return { ...run, conclusion: view.conclusion, attempt: view.attempt }
      }
      if (view.status !== reported || deps.now() - reportedAt >= WATCH_REPORT_MS) {
        const minutes = Math.floor((deps.now() - started) / 60_000)
        log(`${run.name}: ${view.status}, ${minutes} min`)
        reported = view.status
        reportedAt = deps.now()
      }
      await deps.sleep(WATCH_INTERVAL_MS)
    }
  }

  // Dispatches and watches one workflow run. The run ID comes only from the URL `gh workflow run`
  // prints, so another dispatch by the same account can never be mistaken for this one.
  async function dispatch({ name, workflow, inputs: build, changesRehome = false }) {
    const inputs = validateDispatchInputs(build(view()))
    // Lets a signal that arrived during synchronous work stop the driver before it dispatches.
    await new Promise((resolveYield) => setImmediate(resolveYield))
    requireQuietLane()
    log(`dispatch ${name}: ${workflow.file} ${JSON.stringify(inputs)}`)
    if (changesRehome) uncertain = { kind: 'changing', name }
    const output = gh(
      words(`workflow run ${workflow.file} -R ${REPOSITORY} --ref ${WORKFLOW_REF} --json`),
      JSON.stringify(inputs)
    )
    const printed = output.match(/\/actions\/runs\/([0-9]+)/)
    if (!printed) {
      throw new DriverStop(
        `gh printed no run URL for ${workflow.file}; upgrade gh. The run may exist: find it before re-running`
      )
    }
    const runId = Number(printed[1])
    const url = runUrl(runId)
    ownRunIds.add(runId)
    if (changesRehome) Object.assign(uncertain, { runId, url })
    log(`${name}: run ${url}`)
    const dispatched = viewRun(runId)
    if (
      dispatched.workflowName !== workflow.name ||
      dispatched.event !== 'workflow_dispatch' ||
      dispatched.headBranch !== WORKFLOW_REF
    ) {
      throw new DriverStop(
        `run ${runUrl(runId)} is not a ${workflow.file} dispatch on ${WORKFLOW_REF}`
      )
    }
    // `uncertain` is cleared by the step only once it has read the run's result.
    return await waitForRun({ name, runId, url, headSha: dispatched.headSha })
  }

  function requireSuccess(run) {
    if (run.conclusion !== 'success') {
      throw new DriverStop(`${run.name} run ${run.url} concluded ${run.conclusion}`)
    }
  }

  async function runLog(runId) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const text = gh(words(`run view ${runId} -R ${REPOSITORY} --log`))
        if (text.trim()) return text
      } catch (error) {
        if (attempt >= LOG_ATTEMPTS)
          throw new Error(`log for ${runUrl(runId)} is unavailable: ${error.message}`)
      }
      if (attempt >= LOG_ATTEMPTS) throw new Error(`log for ${runUrl(runId)} is empty`)
      await deps.sleep(LOG_INTERVAL_MS)
    }
  }

  async function rehomeResult(runId) {
    try {
      return rehomeResultFromLog(await runLog(runId))
    } catch {
      return undefined
    }
  }

  async function withArtifact(runId, artifact, read) {
    const directory = mkdtempSync(join(tmpdir(), 'relay-director-deploy-'))
    try {
      gh(words(`run download ${runId} -R ${REPOSITORY} -n ${artifact} -D ${directory}`))
      return await read(directory)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  async function typed(phrase, meaning = '') {
    if (typedPhrases.has(phrase)) return phrase
    // Ends in a newline, so the prompt is never left mid-line where it can be missed.
    const answer = (await deps.prompt(`Type ${phrase} to continue${meaning}:\n`)).trim()
    if (answer !== phrase)
      throw new DriverStop(`expected ${phrase}; nothing further was dispatched`)
    typedPhrases.set(phrase, answer)
    log(`operator typed ${phrase}`)
    return answer
  }

  // The digest the publish run pushed: the registry's digest for the commit's tag, which the push
  // line in the run's own log must name too.
  async function publishedDigest(runId) {
    const view = viewRun(runId)
    if (view.workflowName !== WORKFLOWS.publish.name || view.conclusion !== 'success') {
      throw new DriverStop(`${runUrl(runId)} is not a successful ${WORKFLOWS.publish.file} run`)
    }
    if (view.headSha !== config.commit) {
      movedBuild = { commit: view.headSha, runId }
      throw new DriverStop(
        `publish ${runUrl(runId)} built ${view.headSha}, not the reviewed ${config.commit}: main moved`
      )
    }
    const tag = `${IMAGE_REPOSITORY}:sha-${config.commit}`
    const digest = command(
      'gcloud',
      words(
        `artifacts docker images describe ${tag} --project ${PROJECT} --format=value(image_summary.digest)`
      )
    ).trim()
    requireDigest(digest, 'registry digest of the published tag')
    if (!logConfirmsPublishedDigest(await runLog(runId), config.commit, digest)) {
      throw new DriverStop(
        `registry digest ${digest} is not the digest ${runUrl(runId)} pushed; the tag moved`
      )
    }
    return digest
  }

  async function lastKnownRehomeGeneration() {
    const runs = ghJson(
      words(
        `run list -R ${REPOSITORY} --workflow ${WORKFLOWS.rehome.file} --status completed --limit ${REHOME_HISTORY_RUNS} --json databaseId`
      )
    )
    for (const run of runs) {
      const result = await rehomeResult(run.databaseId)
      if (result) {
        log(
          `rehome generation candidate ${result.control.generation} from ${runUrl(run.databaseId)}`
        )
        return result.control.generation
      }
    }
    throw new DriverStop(
      'no recent rehome run printed the control generation; pass --rehome-generation'
    )
  }

  // Values every input builder reads. A dry run shows what is not known yet as `<placeholder>`,
  // which validateDispatchInputs refuses, so a placeholder can never be dispatched.
  function view() {
    const unknown = (label) => `<${label}>`
    const placeholder = (label) => new Proxy({}, { get: () => unknown(label) })
    const fromAdmission = [unknown('from admission inspect')]
    const control = known.control
    return {
      director: known.director,
      selector: known.selector ?? {
        generation: fromAdmission[0],
        membership: new Proxy({}, { get: () => fromAdmission })
      },
      control: control ?? placeholder('inspected'),
      pausedGeneration:
        owned?.generation ??
        (control?.enabled === false
          ? control.generation
          : unknown('rehome generation after pause')),
      published: published?.digest ?? unknown('published digest'),
      rollbackDigest: rollbackPoint?.digest ?? known.director?.servingDigest,
      monitor: placeholder('monitor run'),
      afterDeploy: placeholder('digest read from gcloud after the deploy'),
      notBefore: config.dryRun ? unknown('now, epoch ms') : Math.floor(deps.now() / 1000) * 1000,
      confirmation: (phrase) =>
        typedPhrases.has(phrase) ? phrase : unknown(`operator types ${phrase}`)
    }
  }

  const deployPending = () => known.director.servingDigest !== published?.digest
  const pendingWaves = () =>
    config.configure.filter((wave) => wave.cells.some((cell) => !known.director.cells.has(cell)))
  const work = () => deployPending() || pendingWaves().length > 0

  function count5xx(fromMs, toMs) {
    const filter = `${DIRECTOR_5XX_FILTER} AND timestamp>="${timestamp(fromMs)}" AND timestamp<"${timestamp(toMs)}"`
    return command('gcloud', [
      'logging',
      'read',
      filter,
      ...words(`--project ${PROJECT} --limit ${LOG_COUNT_LIMIT} --format=value(timestamp)`)
    ])
      .split('\n')
      .filter(Boolean).length
  }

  // Director 5xx over SOAK_MS on the new image against the same span before its revision existed.
  // The window starts at the traffic switch when this run deployed, otherwise now, so a re-run
  // after a tripped soak judges fresh traffic.
  async function soak(deployedAt) {
    const created = Date.parse(known.director.servingCreatedAt)
    const start =
      deployedAt === undefined ? deps.now() : Math.max(deployedAt - TRAFFIC_SWITCH_LEAD_MS, created)
    const end = start + SOAK_MS
    const readAt = end + LOG_INGESTION_LAG_MS
    if (deps.now() < readAt) {
      log(
        `soak: watching the new director until ${timestamp(end)}, reading at ${timestamp(readAt)}`
      )
      await deps.sleep(readAt - deps.now())
    }
    const before = count5xx(created - SOAK_MS, created)
    const after = count5xx(start, end)
    log(
      `soak: director 5xx ${after} in ${SOAK_MS / 60_000} min on the new image, ${before} before it`
    )
    if (after >= LOG_COUNT_LIMIT || after > 2 * before + 25) {
      throw new DriverStop(
        `director 5xx rose from ${before} to ${after} after the deploy; investigate before configuring cells`
      )
    }
  }

  // The same audited check the enable job runs, on the same sealed files.
  async function monitorCompletedAt(run) {
    const incidentId = `relay-${run.runId}-dry-run`
    return await withArtifact(
      run.runId,
      `relay-monitor-dry-run-${run.runId}-${run.attempt}`,
      async (directory) => {
        try {
          const argv = Object.entries({
            directory,
            'incident-id': incidentId,
            'run-id': run.runId,
            'run-attempt': run.attempt,
            'commit-sha': run.headSha,
            mode: 'dry-run',
            'required-migration-policy': 'strict'
          }).flatMap(([key, value]) => [`--${key}`, String(value)])
          const { state } = await verifyDryRunAuthority(argv, deps.now)
          log(`monitor GREEN, completed ${state.completedAt}`)
          return state.completedAt
        } catch (error) {
          // The freeze reason lives only in the sealed state, never in the run log.
          const sealed = (() => {
            try {
              return JSON.parse(readFileSync(join(directory, `${incidentId}.state.json`), 'utf8'))
            } catch {
              return {}
            }
          })()
          const failures = (sealed.failures ?? []).map((failure) =>
            [
              failure.source,
              failure.code,
              failure.signal,
              failure.observed,
              failure.threshold
            ].join(' ')
          )
          throw new DriverStop(
            [
              `monitor ${run.url} is not usable: ${error.message}`,
              `frozenAt ${sealed.frozenAt}`,
              ...failures
            ].join('\n  ')
          )
        }
      }
    )
  }

  async function preflight() {
    log('preflight: relay workflow lane, target commit, serving director')
    if (config.dryRun) {
      const active = activeRuns()
      if (active.length > 0)
        log(
          `WARNING relay workflows are in flight; a real run would stop:\n  ${active.join('\n  ')}`
        )
    } else {
      requireQuietLane()
    }
    let claim
    if (config.pauseRun) {
      // Only this operator's own rehome-control run can prove a pause belongs to this driver.
      const claimed = ghJson(
        words(
          `api repos/${REPOSITORY}/actions/runs/${config.pauseRun} --jq {path,actor:.triggering_actor.login}`
        )
      )
      if (
        !claimed.path?.split('@')[0].endsWith(`/${WORKFLOWS.rehome.file}`) ||
        claimed.actor !== login
      ) {
        throw new DriverStop(
          `${runUrl(config.pauseRun)} is not a ${WORKFLOWS.rehome.file} run by ${login}, so it cannot prove a pause is this driver's`
        )
      }
      const result = await rehomeResult(config.pauseRun)
      claim = result && pausedGeneration(result)
      if (claim === undefined) {
        throw new DriverStop(
          `${runUrl(config.pauseRun)} printed no pause of its own, so it cannot prove a pause is this driver's`
        )
      }
    }
    if (published) {
      published.digest = await publishedDigest(published.runId)
    } else {
      const main = gh(['api', `repos/${REPOSITORY}/commits/${WORKFLOW_REF}`, '--jq', '.sha']).trim()
      if (main !== config.commit) {
        throw new DriverStop(
          `${WORKFLOW_REF} is at ${main}, not the reviewed ${config.commit}; review the difference and run with --commit ${main}`
        )
      }
      // The workflow builds main's head at dispatch, so it is dispatched seconds after the check
      // rather than after the inspects and the typed phrase; publishing changes nothing serving.
      if (!config.dryRun) await publishStep.run(publishStep)
    }
    known.director = readDirector()
    if (known.director.servingDigest !== published?.digest) {
      rollbackPoint = {
        revision: known.director.servingRevision,
        digest: known.director.servingDigest
      }
    }
    log(describeDirector(known.director))
    // A director safety pause moves the generation without a run; the inspect then fails closed.
    const generation = config.rehomeGeneration ?? (await lastKnownRehomeGeneration())
    if (config.dryRun) {
      known.control = undefined
      return generation
    }
    const [admissionStep, inspectStep] = readSteps(generation)
    const admission = await dispatch(admissionStep)
    requireSuccess(admission)
    known.selector = await withArtifact(
      admission.runId,
      `relay-asia-admission-result-${admission.runId}-${admission.attempt}`,
      (directory) =>
        admissionInspectResult(JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')))
    )
    const inspect = await dispatch(inspectStep)
    if (inspect.conclusion !== 'success') {
      throw new DriverStop(
        `rehome inspect at generation ${generation} failed (${inspect.url}): the generation, selector or a digest moved. A director safety pause bumps the generation. Read the log, then pass --rehome-generation`
      )
    }
    known.control = (await rehomeResult(inspect.runId))?.control
    if (!known.control) throw new DriverStop(`rehome inspect ${inspect.url} printed no control`)
    const control = known.control
    log(
      `rehome: generation ${control.generation}, ${control.enabled ? 'ENABLED' : 'disabled'}; selector generation ${known.selector.generation}`
    )
    if (claim !== undefined) {
      if (!control.enabled && control.generation === claim)
        owned = { generation: claim, runId: config.pauseRun }
      else if (control.enabled && control.generation === claim + 1) enabled = true
      else
        throw new DriverStop(
          `rehome is generation ${control.generation} ${control.enabled ? 'enabled' : 'paused'}, not the pause ${runUrl(config.pauseRun)} made at ${claim}. Something else changed it, such as a director safety pause; this driver will not touch it`
        )
    } else if (control.enabled && config.leaveRehomePaused) {
      throw new DriverStop(
        'rehome is enabled; --leave-rehome-paused accepts only a paused switch. Drop it'
      )
    } else if (!control.enabled && !config.leaveRehomePaused) {
      throw new DriverStop(
        `rehome is paused at generation ${control.generation}, and this run did not pause it. If an earlier run of this driver did, re-run with the --pause-run its log printed. Otherwise pass --leave-rehome-paused to deploy and leave it paused`
      )
    }
    if (control.hostCooldownMs === undefined && (control.enabled || owned)) {
      throw new DriverStop(
        'the director reports no per-host rehome cooldown, so enable would refuse; not pausing'
      )
    }
    return generation
  }

  // The two read-only inspects every real run starts with; never resumed, always run fresh.
  function readSteps(generation) {
    return [
      {
        name: 'preflight-admission',
        workflow: WORKFLOWS.admission,
        inputs: (v) => admissionInspectInputs(v.director.servingDigest)
      },
      {
        name: 'preflight-rehome',
        workflow: WORKFLOWS.rehome,
        inputs: (v) => rehomeInspectInputs({ ...v, controlGeneration: generation })
      }
    ]
  }

  const publishStep = {
    name: 'publish',
    workflow: WORKFLOWS.publish,
    inputs: publishInputs,
    when: () => !published,
    run: async (step) => {
      const run = await dispatch(step)
      requireSuccess(run)
      published = { runId: run.runId }
      published.digest = await publishedDigest(run.runId)
      log(`published ${IMAGE_REPOSITORY}@${published.digest}`)
    }
  }

  // The one ordered plan. `when` reads live state, so a re-run skips what is already done; a dry run
  // prints every step whose need it cannot know yet.
  function plan() {
    let deployedAt
    let verified
    let monitor
    return [
      publishStep,
      {
        name: 'pause',
        workflow: WORKFLOWS.rehome,
        changesRehome: true,
        inputs: (v) =>
          rehomePauseInputs({ ...v, confirmation: v.confirmation('PAUSE_REGIONAL_REHOMING') }),
        when: () => known.control?.enabled === true && !owned && work(),
        run: async (step) => {
          await typed('PAUSE_REGIONAL_REHOMING')
          const run = await dispatch(step)
          const result = await rehomeResult(run.runId)
          const generation = result && pausedGeneration(result)
          if (generation !== known.control.generation + 1) {
            uncertain.kind = 'unconfirmed'
            throw new DriverStop(
              `${run.url} (${run.conclusion}) printed no pause at generation ${known.control.generation + 1}`
            )
          }
          owned = { generation, runId: run.runId }
          uncertain = undefined
          log(
            `REHOME PAUSED at generation ${generation}. To finish from here after any stop: ${rerunCommand()}`
          )
        }
      },
      {
        name: 'deploy',
        workflow: WORKFLOWS.director,
        inputs: (v) =>
          directorDeployInputs({
            imageDigest: v.published,
            predecessorDigest: v.rollbackDigest,
            rehomeGeneration: v.pausedGeneration
          }),
        when: () => !published || deployPending(),
        run: async (step) => {
          requireSuccess(await dispatch(step))
          deployedAt = deps.now()
          known.director = readDirector()
          if (deployPending())
            throw new DriverStop(
              `deploy: ${describeDirector(known.director)}, not ${published.digest}`
            )
        }
      },
      ...config.configure.slice(0, 1).map(() => ({
        name: 'soak',
        description: `wait ${SOAK_MS / 60_000} min, then compare director 5xx`,
        // A wave already configured means an earlier run passed the soak on this image.
        when: () => pendingWaves().length === config.configure.length,
        run: () => soak(deployedAt)
      })),
      ...config.configure.map((wave) => ({
        name: `configure:${wave.cells.join(',')}`,
        workflow: WORKFLOWS.admission,
        inputs: (v) =>
          configureInputs({
            ...wave,
            directorDigest: v.published,
            selectorGeneration: v.selector.generation,
            confirmation: v.confirmation('CONFIGURE_ASIA_DIRECTOR')
          }),
        when: () => pendingWaves().includes(wave),
        run: async (step) => {
          await typed('CONFIGURE_ASIA_DIRECTOR')
          requireSuccess(await dispatch(step))
          known.director = readDirector()
          if (deployPending())
            throw new DriverStop(
              `${step.name}: ${describeDirector(known.director)}, not ${published.digest}`
            )
        }
      })),
      // Inspect binds the exact serving and rollback digests, so a wrong one fails here, read-only,
      // before 15 minutes of monitor evidence is spent on it.
      {
        name: 'verify-identities',
        workflow: WORKFLOWS.rehome,
        inputs: (v) =>
          rehomeInspectInputs({
            director: verified ?? v.afterDeploy,
            selector: v.selector,
            controlGeneration: v.pausedGeneration
          }),
        when: () => Boolean(owned),
        run: async (step) => {
          verified = readDirector()
          const run = await dispatch(step)
          const control = (await rehomeResult(run.runId))?.control
          if (
            run.conclusion !== 'success' ||
            control?.enabled !== false ||
            control.generation !== owned.generation
          ) {
            throw new DriverStop(
              `verify-identities ${run.url} (${run.conclusion}) did not find rehome paused at ${owned.generation} with ${describeDirector(verified)}`
            )
          }
        }
      },
      {
        name: 'monitor',
        workflow: WORKFLOWS.monitor,
        inputs: (v) => monitorDryRunInputs(v.selector),
        when: () => Boolean(owned),
        run: async (step) => {
          // The operator arms the enable before the 15-minute watch; it still dispatches only on green.
          await typed(
            'ENABLE_REGIONAL_REHOMING',
            ` (this arms an automatic enable, sent about 17 min from now and only if the monitor is green and its evidence is at most ${MONITOR_MAX_AGE_AT_ENABLE_MS / 1000} s old)`
          )
          const run = await dispatch(step)
          requireSuccess(run)
          monitor = {
            runId: run.runId,
            attempt: run.attempt,
            completedAt: await monitorCompletedAt(run)
          }
        }
      },
      {
        name: 'enable',
        workflow: WORKFLOWS.rehome,
        changesRehome: true,
        inputs: (v) =>
          rehomeEnableInputs({
            ...v,
            director: verified ?? v.afterDeploy,
            controlGeneration: v.pausedGeneration,
            monitor: monitor ?? v.monitor,
            confirmation: v.confirmation('ENABLE_REGIONAL_REHOMING')
          }),
        when: () => Boolean(owned),
        run: async (step) => {
          const ageMs = deps.now() - Date.parse(monitor.completedAt)
          if (ageMs > MONITOR_MAX_AGE_AT_ENABLE_MS) {
            throw new DriverStop(
              `monitor evidence is ${Math.round(ageMs / 1000)} s old, past the ${MONITOR_MAX_AGE_AT_ENABLE_MS / 1000} s budget; re-run for a fresh monitor`
            )
          }
          const now = readDirector()
          if (
            now.servingDigest !== verified.servingDigest ||
            now.rollbackDigest !== verified.rollbackDigest
          ) {
            throw new DriverStop(
              `the director changed after its digests were verified: ${describeDirector(now)}`
            )
          }
          if (known.control.ratePerMinute !== 10)
            log(
              `enable starts at the job's fixed 10 hosts/min (was ${known.control.ratePerMinute})`
            )
          const run = await dispatch(step)
          const result = await rehomeResult(run.runId)
          if (result) known.control = result.control
          // A failed run is never an enable, whatever it printed last.
          if (
            run.conclusion === 'success' &&
            result?.mode === 'enable' &&
            result.control.enabled &&
            result.control.generation === owned.generation + 1
          ) {
            owned = undefined
            uncertain = undefined
            enabled = true
            log(`REHOME RE-ENABLED at generation ${result.control.generation}`)
            return
          }
          if (result?.mode !== 'recover-enable') {
            uncertain.kind = 'unconfirmed'
            throw new DriverStop(`${run.url} (${run.conclusion}) printed no enable result`)
          }
          // Recovery that disabled rehome itself is this driver's pause too. Recovery that found it
          // already disabled at another generation found someone else's pause, such as a director
          // safety pause: this driver gives up ownership and will never lift it.
          uncertain = undefined
          const recovered = pausedGeneration(result)
          if (recovered !== undefined) owned = { generation: recovered, runId: run.runId }
          else if (result.control.generation !== owned.generation) owned = undefined
          throw new DriverStop(
            `enable ${run.url} failed; the job's recovery left rehome paused at generation ${result.control.generation}`
          )
        }
      }
    ]
  }

  function rerunCommand(
    pauseRun = owned?.runId,
    build = published?.digest ? { commit: config.commit, runId: published.runId } : undefined
  ) {
    return [
      'node dev/scripts/drive-relay-director-deploy.mjs',
      `--commit ${build?.commit ?? config.commit}`,
      ...(build ? [`--publish-run ${build.runId}`] : []),
      ...(pauseRun ? [`--pause-run ${pauseRun}`] : []),
      ...(config.leaveRehomePaused ? ['--leave-rehome-paused'] : []),
      ...config.configure.map(
        (wave) => `--configure ${wave.cells.join(',')}=${wave.cellImageDigest}`
      )
    ].join(' ')
  }

  function stopReport(reason) {
    const lines = [`STOPPED: ${reason}`, '', 'State now:']
    const workflowPage = `https://github.com/${REPOSITORY}/actions/workflows/${WORKFLOWS.rehome.file}`
    const where = uncertain?.url ?? `(gh printed no URL; find it at ${workflowPage})`
    if (uncertain?.name === 'pause') {
      lines.push(
        uncertain.kind === 'changing'
          ? `- *** REHOME IS CHANGING: the pause run ${where} was dispatched and applies on its own, if it has not already. ***`
          : `- *** PAUSE UNCONFIRMED: ${where} printed no pause. Rehome MAY BE PAUSED. ***`,
        '  Inspect rehome before walking away.'
      )
      if (uncertain.runId) {
        lines.push(
          `  If it paused rehome at generation ${known.control.generation + 1}, finish with: cd cloud && ${rerunCommand(uncertain.runId)}`
        )
      }
    } else if (uncertain?.name === 'enable') {
      lines.push(
        uncertain.kind === 'changing'
          ? `- *** REHOME IS CHANGING: the enable run ${where} applies on its own: it enables rehome, or disables it again if it fails. ***`
          : `- *** ENABLE UNCONFIRMED: ${where} did not confirm the enable. Rehome may be enabled, or paused. ***`,
        `  If it enabled rehome, or failed before applying, finish with: cd cloud && ${rerunCommand(owned.runId)}`
      )
      if (uncertain.runId) {
        lines.push(
          `  If its recovery paused rehome again, finish with: cd cloud && ${rerunCommand(uncertain.runId)}`
        )
      }
    } else if (owned) {
      lines.push(
        `- *** REHOME IS PAUSED by this driver at generation ${owned.generation} (${runUrl(owned.runId)}). It stays paused until the re-run below enables it. ***`
      )
    } else if (known.control) {
      const state =
        enabled || known.control.enabled
          ? 'enabled'
          : 'PAUSED, not by this driver; it will not be re-enabled here'
      lines.push(`- rehome: generation ${known.control.generation} as last read, ${state}`)
    } else {
      lines.push('- rehome: not read; this run did not change it')
    }
    try {
      lines.push(`- director now: ${describeDirector(readDirector())}`)
    } catch (error) {
      lines.push(`- director: could not re-read (${error.message})`)
    }
    if (published?.digest)
      lines.push(`- published: ${published.digest} (${runUrl(published.runId)})`)
    if (rollbackPoint) {
      lines.push(
        `- rollback point: ${rollbackPoint.revision} ${rollbackPoint.digest}. To undo the deploy, while rehome is paused:`
      )
      lines.push(
        `  ${ghCommand(WORKFLOWS.director, directorDeployInputs({ imageDigest: rollbackPoint.digest, predecessorDigest: rollbackPoint.digest, rehomeGeneration: owned?.generation ?? '<paused generation>' }))}`
      )
    }
    if (movedBuild) {
      // Re-running the reviewed commit would only build the moved main again.
      lines.push(
        '',
        `Review ${config.commit}..${movedBuild.commit}, then deploy that build without rebuilding:`,
        `  cd cloud && ${rerunCommand(undefined, movedBuild)}`
      )
    } else if (!config.dryRun && !uncertain) {
      lines.push(
        '',
        `Re-run to finish from here (it re-reads everything and skips what is done):`,
        `  cd cloud && ${rerunCommand()}`
      )
    }
    return lines.join('\n')
  }

  function ghCommand(workflow, inputs) {
    const fields = Object.entries(inputs).map(([key, value]) => `-f ${key}=${value}`)
    return `gh workflow run ${workflow.file} -R ${REPOSITORY} --ref ${WORKFLOW_REF} ${fields.join(' ')}`
  }

  async function run() {
    const stamp = timestamp(deps.now()).replace(/[:.]/g, '-')
    mkdirSync(config.logDirectory, { recursive: true, mode: 0o700 })
    logPath = join(
      config.logDirectory,
      `${stamp}-${config.commit.slice(0, 12)}${config.dryRun ? '-dry-run' : ''}.log`
    )
    log(`${config.dryRun ? 'dry run' : 'start'}: ${rerunCommand()}`)
    try {
      login = gh(['api', 'user', '--jq', '.login']).trim()
      const generation = await preflight()
      const steps = plan()
      for (const step of [...(config.dryRun ? readSteps(generation) : []), ...steps]) {
        const needed = config.dryRun || step.when() ? '' : ' (done or not needed)'
        const detail = step.workflow
          ? `${step.workflow.file} ${JSON.stringify(step.inputs({ ...view(), control: { ...view().control, generation } }))}`
          : step.description
        log(`plan ${step.name}${needed}: ${detail}`)
      }
      if (config.dryRun) {
        log('dry run: nothing dispatched')
        return { dryRun: true }
      }
      if (steps.some((step) => step.when())) await typed(`DEPLOY ${config.commit.slice(0, 12)}`)
      for (const step of steps) if (step.when()) await step.run(step)
      const rehome =
        enabled || known.control.enabled ? 'enabled' : 'left paused (--leave-rehome-paused)'
      log(
        `DONE: ${describeDirector(known.director)}; rehome ${rehome}${rollbackPoint ? `; rollback point ${rollbackPoint.revision} ${rollbackPoint.digest}` : ''}`
      )
      return { done: true, logPath }
    } catch (error) {
      for (const line of stopReport(error.message).split('\n')) log(line)
      throw Object.assign(error instanceof DriverStop ? error : new DriverStop(error.message), {
        reported: true,
        logPath
      })
    }
  }

  // Ctrl-C, SIGTERM or a closed terminal still leaves the operator the live state and the re-run.
  function interrupt(signal) {
    if (logPath) for (const line of stopReport(`interrupted by ${signal}`).split('\n')) log(line)
  }

  return { run, interrupt }
}

function defaultDependencies() {
  return {
    run: (program, args, input) =>
      spawnSync(program, args, {
        encoding: 'utf8',
        input,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    print: (line) => process.stdout.write(`${line}\n`),
    prompt: async (question) => {
      const reader = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await reader.question(question)
      } finally {
        reader.close()
      }
    }
  }
}

export async function main(argv = process.argv.slice(2), deps = defaultDependencies()) {
  const driver = createDriver(parseDriverArguments(argv), deps)
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129]
  ]) {
    process.once(signal, () => {
      driver.interrupt(signal)
      process.exit(code)
    })
  }
  return await driver.run()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (!error.reported)
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
