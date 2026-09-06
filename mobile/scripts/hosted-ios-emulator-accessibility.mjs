import { spawn } from 'node:child_process'

const EMULATOR_COMMAND_TIMEOUT_MS = 30_000
const EMULATOR_COMMAND_MAX_BYTES = 2 * 1024 * 1024
const ACCESSIBILITY_NODE_LIMIT = 2_000
const EMULATOR_REATTACH_ATTEMPTS = 3

export async function tapHostedIosAccessibilityControl(
  args,
  label,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const point = await waitForHostedIosAccessibilityControlOccurrence(
    args,
    label,
    0,
    timeoutMs,
    runCommand
  )
  await runCommand(args, ['tap', String(point.x), String(point.y)])
  return point
}

export async function tapHostedIosPoint(args, point, runCommand = runHostedIosEmulatorCommand) {
  const command = ['tap', String(point.x), String(point.y)]
  try {
    await runCommand(args, command)
  } catch (error) {
    if (!isMissingActiveEmulatorError(error)) {
      throw error
    }
    await restartHostedIosEmulatorController(args, runCommand)
    await runCommand(args, command)
  }
  return point
}

export async function typeHostedIosText(args, value, runCommand = runHostedIosEmulatorCommand) {
  for (const character of value) {
    const command = ['type', character]
    try {
      await runCommand(args, command)
    } catch (error) {
      if (!isMissingActiveEmulatorError(error)) {
        throw error
      }
      await restartHostedIosEmulatorController(args, runCommand)
      await runCommand(args, command)
    }
  }
}

export async function tapHostedIosAccessibilityControlAtOccurrence(
  args,
  label,
  occurrence,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const point = await waitForHostedIosAccessibilityControlOccurrence(
    args,
    label,
    occurrence,
    timeoutMs,
    runCommand
  )
  await runCommand(args, ['tap', String(point.x), String(point.y)])
  return point
}

export async function tapHostedIosAccessibilityControlAtLastOccurrence(
  args,
  label,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const point = await waitForHostedIosAccessibilityControlOccurrence(
    args,
    label,
    -1,
    timeoutMs,
    runCommand
  )
  await runCommand(args, ['tap', String(point.x), String(point.y)])
  return point
}

export async function tapHostedIosAccessibilityControlByLabelPrefix(
  args,
  labelPrefix,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const point = await waitForHostedIosAccessibilityControlByLabelPrefix(
    args,
    labelPrefix,
    timeoutMs,
    runCommand
  )
  await runCommand(args, ['tap', String(point.x), String(point.y)])
  return point
}

export async function tapHostedIosAccessibilityControlByLabelPrefixAtPosition(
  args,
  labelPrefix,
  position,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const point = await waitForHostedIosAccessibilityControlOccurrence(
    args,
    labelPrefix,
    0,
    timeoutMs,
    runCommand,
    (node) => node.label === labelPrefix || node.label?.startsWith(`${labelPrefix},`),
    (frame) => ({
      x: frame.x + frame.width * position.x,
      y: frame.y + frame.height * position.y
    })
  )
  await runCommand(args, ['tap', String(point.x), String(point.y)])
  return point
}

export async function tapHostedIosAccessibilityControlStartingWith(
  args,
  labelPrefix,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const point = await waitForHostedIosAccessibilityControlStartingWith(
    args,
    labelPrefix,
    timeoutMs,
    runCommand
  )
  await runCommand(args, ['tap', String(point.x), String(point.y)])
  return point
}

export async function waitForHostedIosAccessibilityControlByLabelPrefix(
  args,
  labelPrefix,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  return waitForHostedIosAccessibilityControlOccurrence(
    args,
    labelPrefix,
    0,
    timeoutMs,
    runCommand,
    (node) => node.label === labelPrefix || node.label?.startsWith(`${labelPrefix},`)
  )
}

export async function waitForHostedIosAccessibilityControlStartingWith(
  args,
  labelPrefix,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  return waitForHostedIosAccessibilityControlOccurrence(
    args,
    labelPrefix,
    0,
    timeoutMs,
    runCommand,
    (node) => node.label?.startsWith(labelPrefix) || node.value?.startsWith(labelPrefix)
  )
}

export async function waitForHostedIosAccessibilityControlEndingWith(
  args,
  labelSuffix,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  return waitForHostedIosAccessibilityControlOccurrence(
    args,
    labelSuffix,
    0,
    timeoutMs,
    runCommand,
    (node) => node.label?.endsWith(labelSuffix) || node.value?.endsWith(labelSuffix)
  )
}

export async function waitForHostedIosAccessibilityControl(
  args,
  label,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  return waitForHostedIosAccessibilityControlOccurrence(args, label, 0, timeoutMs, runCommand)
}

export async function waitForHostedIosAccessibilityControlMatch(
  args,
  labels,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const deadline = Date.now() + timeoutMs
  let lastLabels = []
  while (Date.now() < deadline) {
    const nodes = await readAccessibilityNodesUntilDeadline(args, runCommand, deadline)
    lastLabels = accessibilityLabels(nodes)
    for (const label of labels) {
      const control = nodes.find(
        (node) =>
          (node.label === label || node.value === label) &&
          node.enabled !== false &&
          isFiniteFrame(node.frame)
      )
      if (!control) {
        continue
      }
      const point = {
        x: control.frame.x + control.frame.width / 2,
        y: control.frame.y + control.frame.height / 2
      }
      if (isNormalizedPoint(point)) {
        return { label, ...point }
      }
    }
    await delay(250)
  }
  throw new Error(
    `${labels.join(' or ')} was not accessible. Last labels: ${lastLabels.slice(-40).join(', ')}`
  )
}

export async function waitForHostedIosAccessibilityControlMatching(
  args,
  matches,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  return waitForHostedIosAccessibilityControlOccurrence(
    args,
    'matching accessibility control',
    0,
    timeoutMs,
    runCommand,
    matches,
    (frame) => ({
      x: frame.x + frame.width / 2,
      y: frame.y + frame.height / 2
    }),
    (node, point) => ({ ...point, label: node.label ?? '', value: node.value ?? '' })
  )
}

export async function waitForHostedIosAccessibilityLabel(
  args,
  label,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const nodes = await readAccessibilityNodesUntilDeadline(args, runCommand, deadline)
    const node = nodes.find(
      (candidate) =>
        (candidate.label === label || candidate.value === label) &&
        candidate.enabled !== false &&
        isVisibleFrame(candidate.frame)
    )
    if (node) {
      return { frame: node.frame, label: node.label ?? '', value: node.value ?? '' }
    }
    await delay(250)
  }
  throw new Error(`${label} was not accessible in the visible viewport`)
}

export async function readHostedIosAccessibilityLabels(
  args,
  runCommand = runHostedIosEmulatorCommand
) {
  return accessibilityLabels(await readAccessibilityNodes(args, runCommand))
}

export async function rotateHostedIosEmulator(
  args,
  orientation,
  runCommand = runHostedIosEmulatorCommand
) {
  await runCommand(args, ['rotate', orientation])
}

async function waitForHostedIosAccessibilityControlOccurrence(
  args,
  label,
  occurrence,
  timeoutMs,
  runCommand,
  matchesLabel = (node) => node.label === label || node.value === label,
  pointForFrame = (frame) => ({
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2
  }),
  resultForControl = (_node, point) => point
) {
  const deadline = Date.now() + timeoutMs
  let lastLabels = []
  while (Date.now() < deadline) {
    const nodes = await readAccessibilityNodesUntilDeadline(args, runCommand, deadline)
    lastLabels = accessibilityLabels(nodes)
    const controls = nodes.filter(
      (node) => matchesLabel(node) && node.enabled !== false && isFiniteFrame(node.frame)
    )
    const control = occurrence === -1 ? controls.at(-1) : controls[occurrence]
    if (control) {
      const point = pointForFrame(control.frame)
      if (isNormalizedPoint(point)) {
        return resultForControl(control, point)
      }
    }
    await delay(250)
  }
  throw new Error(`${label} was not accessible. Last labels: ${lastLabels.slice(-40).join(', ')}`)
}

export async function waitForHostedIosAccessibilityLabelToDisappear(
  args,
  label,
  timeoutMs,
  runCommand = runHostedIosEmulatorCommand
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const labels = accessibilityLabels(
      await readAccessibilityNodesUntilDeadline(args, runCommand, deadline)
    )
    if (!labels.includes(label)) {
      return
    }
    await delay(250)
  }
  throw new Error(`${label} remained accessible after the timeout`)
}

export function runHostedIosEmulatorCommand(args, command) {
  const deviceArgs = command[0] === 'attach' ? [] : ['--device', args.deviceUdid]
  const argv = [
    'emulator',
    ...command,
    ...deviceArgs,
    '--worktree',
    `path:${args.worktree}`,
    '--json'
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(args.orcaCli, argv, {
      cwd: args.worktree,
      detached: true,
      env: {
        ...process.env,
        ORCA_DEV_USER_DATA_PATH: args.userDataDir,
        ORCA_USER_DATA_PATH: args.userDataDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let settled = false
    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => {
      killProcessGroup(child)
      finish(new Error(`Orca emulator command timed out: ${command[0] ?? 'unknown'}`))
    }, EMULATOR_COMMAND_TIMEOUT_MS)
    const finish = (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error)
      } else {
        resolve({ stderr, stdout })
      }
    }
    const append = (current, chunk) => {
      const next = current + String(chunk)
      if (Buffer.byteLength(next) > EMULATOR_COMMAND_MAX_BYTES) {
        killProcessGroup(child)
        finish(new Error('Orca emulator command exceeded its output limit'))
        return current
      }
      return next
    }
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', finish)
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish()
      } else {
        finish(
          new Error(
            `Orca emulator command failed (${code ?? signal ?? 'unknown'}): ${stderr || stdout}`
          )
        )
      }
    })
  })
}

async function readAccessibilityNodes(args, runCommand) {
  const { stdout } = await runCommand(args, ['ax'])
  const response = JSON.parse(stdout)
  if (response?.ok !== true || !Array.isArray(response.result)) {
    throw new Error('Orca emulator returned an invalid accessibility response')
  }
  const roots = response.result.filter(isAccessibilityNode)
  const nodes = []
  const pending = [...roots]
  while (pending.length > 0 && nodes.length < ACCESSIBILITY_NODE_LIMIT) {
    const node = pending.shift()
    nodes.push(node)
    if (Array.isArray(node.children)) {
      pending.push(...node.children.filter(isAccessibilityNode))
    }
  }
  return nodes
}

async function readAccessibilityNodesUntilDeadline(args, runCommand, deadline) {
  let didRestartController = false
  while (true) {
    try {
      return await readAccessibilityNodes(args, runCommand)
    } catch (error) {
      if (!isTransientAccessibilityReadError(error) || Date.now() >= deadline) {
        throw error
      }
      if (!didRestartController) {
        didRestartController = true
        await restartHostedIosEmulatorController(args, runCommand)
      }
      await delay(250)
    }
  }
}

export async function restartHostedIosEmulatorController(
  args,
  runCommand = runHostedIosEmulatorCommand
) {
  await runCommand(args, ['kill']).catch(() => {})
  let lastError
  for (let attempt = 0; attempt < EMULATOR_REATTACH_ATTEMPTS; attempt += 1) {
    await delay(250)
    try {
      await runCommand(args, ['attach', args.deviceUdid])
      return
    } catch (error) {
      lastError = error
      if (!isTransientAccessibilityReadError(error)) {
        throw error
      }
    }
  }
  throw lastError
}

function isTransientAccessibilityReadError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    isMissingActiveEmulatorError(error) ||
    message.includes('emulator_helper_failed') ||
    message.includes('request timed out') ||
    message.includes('emulator command timed out')
  )
}

function isMissingActiveEmulatorError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('emulator_no_active')
}

function accessibilityLabels(nodes) {
  return nodes.flatMap((node) =>
    [node.label, node.value].filter((value) => typeof value === 'string' && value.length > 0)
  )
}

function isAccessibilityNode(value) {
  return Boolean(value && typeof value === 'object')
}

function isFiniteFrame(frame) {
  return (
    frame &&
    [frame.x, frame.y, frame.width, frame.height].every(
      (value) => typeof value === 'number' && Number.isFinite(value)
    )
  )
}

function isVisibleFrame(frame) {
  return (
    isFiniteFrame(frame) &&
    frame.x + frame.width > 0 &&
    frame.y + frame.height > 0 &&
    frame.x < 1 &&
    frame.y < 1
  )
}

function isNormalizedPoint(point) {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
}

function killProcessGroup(child) {
  if (!child.pid) {
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
