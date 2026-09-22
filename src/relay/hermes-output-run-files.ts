import { existsSync } from 'node:fs'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HERMES_HOME, HERMES_OUTPUT_DIR } from './external-automation-storage-paths'
import type { HermesOutputRunRef } from './hermes-run-correlation'

const HERMES_OUTPUT_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/
const MAX_REFERENCED_LOG_BYTES = 5 * 1024 * 1024
const REFERENCED_LOG_HEADING = '## Latest log file'
const LATEST_LOG_PATH_PATTERN =
  /\bLatest log path:\s*(?<path>(?:[A-Za-z]:[\\/]|\/)[^\r\n]*?)(?=\s+Run summary:|\r?\n|$)/i

function runAtFromHermesOutputFile(filename: string): string | null {
  const match = HERMES_OUTPUT_FILE_PATTERN.exec(filename)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

function runKeyFromHermesOutputFile(filename: string): string | null {
  const match = HERMES_OUTPUT_FILE_PATTERN.exec(filename)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute, second] = match
  return `${year}${month}${day}_${hour}${minute}${second}`
}

function cleanRunPreview(value: string): string | null {
  const normalized = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>()]/g, ' ')
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) {
    return null
  }
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized
}

function parseHermesOutput(content: string): {
  status: 'completed' | 'failed' | 'unknown'
  outputPreview: string | null
  outputContent: string
  error: string | null
} {
  const failed = /^#\s+Cron Job:.*\(FAILED\)/m.test(content) || /^##\s+Error\b/m.test(content)
  const errorMatch = /##\s+Error\s+```([\s\S]*?)```/m.exec(content)
  const responseMatch = /##\s+Response\s+([\s\S]*)$/m.exec(content)
  const error = errorMatch ? cleanRunPreview(errorMatch[1]) : null
  return {
    status: failed ? 'failed' : responseMatch ? 'completed' : 'unknown',
    outputPreview: cleanRunPreview(responseMatch?.[1] ?? errorMatch?.[1] ?? content),
    outputContent: content,
    error
  }
}

function extractLatestLogPath(content: string): string | null {
  const rawPath = LATEST_LOG_PATH_PATTERN.exec(content)?.groups?.path?.trim()
  if (!rawPath) {
    return null
  }
  return rawPath.replace(/^`|`$/g, '').trim()
}

export async function readHermesReferencedLogFile(content: string): Promise<{
  path: string
  content: string
  truncated: boolean
} | null> {
  const logPath = extractLatestLogPath(content)
  if (!logPath || !isAbsolute(logPath)) {
    return null
  }
  try {
    const homeRealPath = await realpath(HERMES_HOME)
    const logRealPath = await realpath(logPath)
    const relativeToHermesHome = relative(resolve(homeRealPath), resolve(logRealPath))
    if (
      relativeToHermesHome === '..' ||
      relativeToHermesHome.startsWith(`..${sep}`) ||
      isAbsolute(relativeToHermesHome)
    ) {
      return null
    }
    const logStat = await stat(logPath)
    if (!logStat.isFile()) {
      return null
    }
    if (logStat.size <= MAX_REFERENCED_LOG_BYTES) {
      return {
        path: logPath,
        content: await readFile(logPath, 'utf-8'),
        truncated: false
      }
    }
    const file = await open(logPath, 'r')
    try {
      const buffer = Buffer.alloc(MAX_REFERENCED_LOG_BYTES)
      await file.read(buffer, 0, MAX_REFERENCED_LOG_BYTES, logStat.size - MAX_REFERENCED_LOG_BYTES)
      return {
        path: logPath,
        content: buffer.toString('utf-8'),
        truncated: true
      }
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function appendReferencedLogFile(content: string): Promise<string> {
  if (content.includes(REFERENCED_LOG_HEADING)) {
    return content
  }
  const logFile = await readHermesReferencedLogFile(content)
  if (!logFile) {
    return content
  }
  const note = logFile.truncated
    ? `Showing the last ${MAX_REFERENCED_LOG_BYTES} bytes because the log file is larger.`
    : null
  return [
    content,
    '---',
    REFERENCED_LOG_HEADING,
    '',
    `Path: ${logFile.path}`,
    note,
    '```text',
    logFile.content.trimEnd(),
    '```'
  ]
    .filter((part) => part !== null)
    .join('\n\n')
}

export async function readHermesOutputFileRunRefs(jobId: string): Promise<HermesOutputRunRef[]> {
  const outputDir = join(HERMES_OUTPUT_DIR, jobId)
  if (!existsSync(outputDir)) {
    return []
  }
  const entries = await readdir(outputDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && HERMES_OUTPUT_FILE_PATTERN.test(entry.name))
    .map((entry) => ({
      kind: 'output',
      id: `${jobId}:${entry.name}`,
      job_id: jobId,
      run_at: runAtFromHermesOutputFile(entry.name),
      run_key: runKeyFromHermesOutputFile(entry.name),
      output_path: join(outputDir, entry.name)
    }))
}

export async function readHermesOutputFileRun(ref: HermesOutputRunRef): Promise<unknown> {
  try {
    const content = await readFile(ref.output_path, 'utf-8')
    const parsed = parseHermesOutput(content)
    const outputContent = await appendReferencedLogFile(parsed.outputContent)
    return {
      id: ref.id,
      job_id: ref.job_id,
      run_at: ref.run_at,
      run_key: ref.run_key,
      status: parsed.status,
      output_preview: parsed.outputPreview,
      output_content: outputContent,
      error: parsed.error,
      output_path: ref.output_path
    }
  } catch (error) {
    return {
      id: ref.id,
      job_id: ref.job_id,
      run_at: ref.run_at,
      run_key: ref.run_key,
      status: 'unknown',
      output_preview: null,
      output_content: null,
      error: error instanceof Error ? error.message : String(error),
      output_path: ref.output_path
    }
  }
}
