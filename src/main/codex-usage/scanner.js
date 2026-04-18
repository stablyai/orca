/* eslint-disable max-lines -- Why: Codex discovery, incremental parsing, attribution, and aggregation all depend on the same event-normalization rules. Keeping them together makes the duplicate-snapshot logic easier to audit when usage totals look wrong. */
import { homedir } from 'os';
import { basename, join, win32, posix } from 'path';
import { createReadStream } from 'fs';
import { realpath, readdir, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { areWorktreePathsEqual } from '../ipc/worktree-logic';
const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const LEGACY_FALLBACK_MODEL = 'gpt-5';
const YIELD_EVERY_FILES = 10;
function ensureNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function normalizeComparablePath(pathValue, platform = process.platform) {
    const normalized = pathValue.replace(/\\/g, '/');
    return platform === 'win32' || looksLikeWindowsPath(pathValue)
        ? normalized.toLowerCase()
        : normalized;
}
function normalizeFsPath(pathValue, platform = process.platform) {
    if (platform === 'win32' || looksLikeWindowsPath(pathValue)) {
        return win32.normalize(win32.resolve(pathValue));
    }
    return posix.normalize(posix.resolve(pathValue));
}
function looksLikeWindowsPath(pathValue) {
    return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\');
}
async function canonicalizePath(pathValue) {
    try {
        const resolved = await realpath(pathValue);
        return normalizeFsPath(resolved);
    }
    catch {
        return normalizeFsPath(pathValue);
    }
}
async function yieldToEventLoop() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}
async function walkJsonlFiles(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walkJsonlFiles(fullPath)));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push(fullPath);
        }
    }
    return files;
}
export function getCodexSessionsDirectory() {
    const codexHome = process.env.CODEX_HOME?.trim();
    if (codexHome) {
        return join(codexHome, 'sessions');
    }
    return DEFAULT_CODEX_SESSIONS_DIR;
}
export async function listCodexSessionFiles() {
    try {
        return (await walkJsonlFiles(getCodexSessionsDirectory())).sort();
    }
    catch {
        return [];
    }
}
export async function getProcessedFileInfo(filePath) {
    const fileStat = await stat(filePath);
    return {
        path: filePath,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size
    };
}
function normalizeRawUsage(value) {
    if (value == null || typeof value !== 'object') {
        return null;
    }
    const record = value;
    const inputTokens = ensureNumber(record.input_tokens);
    const cachedInputTokens = ensureNumber(record.cached_input_tokens ?? record.cache_read_input_tokens);
    const outputTokens = ensureNumber(record.output_tokens);
    const reasoningOutputTokens = ensureNumber(record.reasoning_output_tokens);
    const totalTokens = ensureNumber(record.total_tokens);
    return {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        // Why: legacy Codex logs can omit total_tokens. Reasoning is already billed
        // inside output, so synthesizing input+output matches Codex pricing instead
        // of double-counting reasoning as another billable bucket.
        totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens
    };
}
function subtractRawUsage(current, previous) {
    return {
        inputTokens: Math.max(current.inputTokens - (previous?.inputTokens ?? 0), 0),
        cachedInputTokens: Math.max(current.cachedInputTokens - (previous?.cachedInputTokens ?? 0), 0),
        outputTokens: Math.max(current.outputTokens - (previous?.outputTokens ?? 0), 0),
        reasoningOutputTokens: Math.max(current.reasoningOutputTokens - (previous?.reasoningOutputTokens ?? 0), 0),
        totalTokens: Math.max(current.totalTokens - (previous?.totalTokens ?? 0), 0)
    };
}
function extractString(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function extractModel(value) {
    if (value == null || typeof value !== 'object') {
        return null;
    }
    const record = value;
    const direct = [extractString(record.model), extractString(record.model_name)].find((candidate) => candidate !== null);
    if (direct) {
        return direct;
    }
    if (record.info && typeof record.info === 'object') {
        const info = record.info;
        const infoDirect = [extractString(info.model), extractString(info.model_name)].find((candidate) => candidate !== null);
        if (infoDirect) {
            return infoDirect;
        }
        if (info.metadata && typeof info.metadata === 'object') {
            const metadata = info.metadata;
            const metadataModel = extractString(metadata.model);
            if (metadataModel) {
                return metadataModel;
            }
        }
    }
    if (record.metadata && typeof record.metadata === 'object') {
        const metadata = record.metadata;
        return extractString(metadata.model);
    }
    return null;
}
function getDefaultProjectLabel(cwd) {
    if (!cwd) {
        return 'Unknown location';
    }
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length >= 2) {
        return parts.slice(-2).join('/');
    }
    return parts.at(-1) ?? cwd;
}
function localDayFromTimestamp(timestamp) {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
async function buildWorktreesWithCanonicalPaths(worktrees) {
    const canonicalized = await Promise.all(worktrees.map(async (worktree) => ({
        ...worktree,
        canonicalPath: await canonicalizePath(worktree.path)
    })));
    return canonicalized.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length);
}
function isContainingPath(candidatePath, targetPath) {
    const useWin32 = looksLikeWindowsPath(candidatePath) || looksLikeWindowsPath(targetPath);
    const relativePath = useWin32
        ? win32.relative(candidatePath, targetPath)
        : posix.relative(candidatePath, targetPath);
    if (!relativePath) {
        return true;
    }
    // Why: on Windows, `path.relative('C:\\repo', 'D:\\other')` returns an
    // absolute `D:\\other` path instead of a `..`-prefixed relative. Treating
    // that as "contained" would attribute off-drive Codex usage to the wrong
    // Orca worktree.
    const isAbsoluteRelative = useWin32
        ? win32.isAbsolute(relativePath)
        : posix.isAbsolute(relativePath);
    return !isAbsoluteRelative && !relativePath.startsWith('..') && relativePath !== '.';
}
function findContainingWorktree(cwd, worktrees) {
    const normalizedCwd = normalizeFsPath(cwd);
    for (const worktree of worktrees) {
        if (areWorktreePathsEqual(worktree.canonicalPath, normalizedCwd)) {
            return worktree;
        }
        if (isContainingPath(worktree.canonicalPath, normalizedCwd)) {
            return worktree;
        }
    }
    return null;
}
export async function attributeCodexUsageEvent(event, worktrees) {
    const day = localDayFromTimestamp(event.timestamp);
    if (!day) {
        return null;
    }
    let repoId = null;
    let worktreeId = null;
    let projectKey = 'unscoped';
    let projectLabel = getDefaultProjectLabel(event.cwd);
    if (event.cwd) {
        const worktree = findContainingWorktree(event.cwd, worktrees);
        if (worktree) {
            repoId = worktree.repoId;
            worktreeId = worktree.worktreeId;
            projectKey = `worktree:${worktree.worktreeId}`;
            projectLabel = worktree.displayName;
        }
        else {
            // Why: all-local mode should still collapse repeated off-Orca sessions by
            // location, but those keys must normalize slash/case differences so the
            // same folder does not fragment into multiple "projects" across platforms.
            projectKey = `cwd:${normalizeComparablePath(event.cwd)}`;
        }
    }
    return {
        ...event,
        day,
        projectKey,
        projectLabel,
        repoId,
        worktreeId
    };
}
function createEmptySession(event) {
    return {
        sessionId: event.sessionId,
        firstTimestamp: event.timestamp,
        lastTimestamp: event.timestamp,
        primaryModel: event.model,
        hasMixedModels: false,
        primaryProjectLabel: event.projectLabel,
        hasMixedLocations: false,
        primaryWorktreeId: event.worktreeId,
        primaryRepoId: event.repoId,
        eventCount: 0,
        totalInputTokens: 0,
        totalCachedInputTokens: 0,
        totalOutputTokens: 0,
        totalReasoningOutputTokens: 0,
        totalTokens: 0,
        hasInferredPricing: false,
        locationBreakdown: [],
        modelBreakdown: [],
        locationModelBreakdown: []
    };
}
function createEmptyDailyAggregate(event) {
    return {
        day: event.day,
        model: event.model,
        projectKey: event.projectKey,
        projectLabel: event.projectLabel,
        repoId: event.repoId,
        worktreeId: event.worktreeId,
        eventCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        hasInferredPricing: false
    };
}
function mergeLocationBreakdown(target, event) {
    const existing = target.find((entry) => entry.locationKey === event.projectKey) ?? null;
    if (existing) {
        existing.eventCount++;
        existing.inputTokens += event.inputTokens;
        existing.cachedInputTokens += event.cachedInputTokens;
        existing.outputTokens += event.outputTokens;
        existing.reasoningOutputTokens += event.reasoningOutputTokens;
        existing.totalTokens += event.totalTokens;
        existing.hasInferredPricing ||= event.hasInferredPricing;
        return;
    }
    target.push({
        locationKey: event.projectKey,
        projectLabel: event.projectLabel,
        repoId: event.repoId,
        worktreeId: event.worktreeId,
        eventCount: 1,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        totalTokens: event.totalTokens,
        hasInferredPricing: event.hasInferredPricing
    });
}
function mergeModelBreakdown(target, event) {
    const key = event.model ?? 'unknown';
    const existing = target.find((entry) => entry.modelKey === key) ?? null;
    if (existing) {
        existing.eventCount++;
        existing.inputTokens += event.inputTokens;
        existing.cachedInputTokens += event.cachedInputTokens;
        existing.outputTokens += event.outputTokens;
        existing.reasoningOutputTokens += event.reasoningOutputTokens;
        existing.totalTokens += event.totalTokens;
        existing.hasInferredPricing ||= event.hasInferredPricing;
        return;
    }
    target.push({
        modelKey: key,
        modelLabel: event.model ?? 'Unknown model',
        eventCount: 1,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        totalTokens: event.totalTokens,
        hasInferredPricing: event.hasInferredPricing
    });
}
function mergeLocationModelBreakdown(target, event) {
    const modelKey = event.model ?? 'unknown';
    const existing = target.find((entry) => entry.locationKey === event.projectKey && entry.modelKey === modelKey) ??
        null;
    if (existing) {
        existing.eventCount++;
        existing.inputTokens += event.inputTokens;
        existing.cachedInputTokens += event.cachedInputTokens;
        existing.outputTokens += event.outputTokens;
        existing.reasoningOutputTokens += event.reasoningOutputTokens;
        existing.totalTokens += event.totalTokens;
        existing.hasInferredPricing ||= event.hasInferredPricing;
        return;
    }
    target.push({
        locationKey: event.projectKey,
        modelKey,
        modelLabel: event.model ?? 'Unknown model',
        repoId: event.repoId,
        worktreeId: event.worktreeId,
        eventCount: 1,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        totalTokens: event.totalTokens,
        hasInferredPricing: event.hasInferredPricing
    });
}
function aggregateCodexUsage(events) {
    const sessionsById = new Map();
    const dailyByKey = new Map();
    for (const event of events) {
        const session = sessionsById.get(event.sessionId) ?? createEmptySession(event);
        if (!sessionsById.has(event.sessionId)) {
            sessionsById.set(event.sessionId, session);
        }
        if (event.timestamp < session.firstTimestamp) {
            session.firstTimestamp = event.timestamp;
        }
        if (event.timestamp >= session.lastTimestamp) {
            session.lastTimestamp = event.timestamp;
        }
        session.eventCount++;
        session.totalInputTokens += event.inputTokens;
        session.totalCachedInputTokens += event.cachedInputTokens;
        session.totalOutputTokens += event.outputTokens;
        session.totalReasoningOutputTokens += event.reasoningOutputTokens;
        session.totalTokens += event.totalTokens;
        session.hasInferredPricing ||= event.hasInferredPricing;
        mergeLocationBreakdown(session.locationBreakdown, event);
        mergeModelBreakdown(session.modelBreakdown, event);
        mergeLocationModelBreakdown(session.locationModelBreakdown, event);
        const dailyKey = [event.day, event.model ?? 'unknown', event.projectKey].join('::');
        const daily = dailyByKey.get(dailyKey) ?? createEmptyDailyAggregate(event);
        if (!dailyByKey.has(dailyKey)) {
            dailyByKey.set(dailyKey, daily);
        }
        daily.eventCount++;
        daily.inputTokens += event.inputTokens;
        daily.cachedInputTokens += event.cachedInputTokens;
        daily.outputTokens += event.outputTokens;
        daily.reasoningOutputTokens += event.reasoningOutputTokens;
        daily.totalTokens += event.totalTokens;
        daily.hasInferredPricing ||= event.hasInferredPricing;
    }
    return {
        sessions: finalizeSessions(sessionsById),
        dailyAggregates: [...dailyByKey.values()].sort((left, right) => left.day === right.day
            ? left.projectLabel.localeCompare(right.projectLabel)
            : left.day.localeCompare(right.day))
    };
}
function finalizeSessions(sessionsById) {
    for (const session of sessionsById.values()) {
        session.locationBreakdown.sort((left, right) => right.totalTokens - left.totalTokens);
        session.modelBreakdown.sort((left, right) => right.totalTokens - left.totalTokens);
        const primaryLocation = session.locationBreakdown[0] ?? null;
        const primaryModel = session.modelBreakdown[0] ?? null;
        session.primaryProjectLabel =
            session.locationBreakdown.length <= 1
                ? (primaryLocation?.projectLabel ?? 'Unknown location')
                : 'Multiple locations';
        session.hasMixedLocations = session.locationBreakdown.length > 1;
        session.primaryWorktreeId = primaryLocation?.worktreeId ?? null;
        session.primaryRepoId = primaryLocation?.repoId ?? null;
        session.primaryModel =
            session.modelBreakdown.length <= 1 ? (primaryModel?.modelLabel ?? null) : 'Mixed models';
        session.hasMixedModels = session.modelBreakdown.length > 1;
    }
    return [...sessionsById.values()].sort((left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp));
}
function mergeSessions(target, sessions) {
    for (const session of sessions) {
        const existing = target.get(session.sessionId);
        if (!existing) {
            target.set(session.sessionId, structuredClone(session));
            continue;
        }
        existing.firstTimestamp =
            session.firstTimestamp < existing.firstTimestamp
                ? session.firstTimestamp
                : existing.firstTimestamp;
        existing.lastTimestamp =
            session.lastTimestamp > existing.lastTimestamp
                ? session.lastTimestamp
                : existing.lastTimestamp;
        existing.eventCount += session.eventCount;
        existing.totalInputTokens += session.totalInputTokens;
        existing.totalCachedInputTokens += session.totalCachedInputTokens;
        existing.totalOutputTokens += session.totalOutputTokens;
        existing.totalReasoningOutputTokens += session.totalReasoningOutputTokens;
        existing.totalTokens += session.totalTokens;
        existing.hasInferredPricing ||= session.hasInferredPricing;
        for (const location of session.locationBreakdown) {
            const existingLocation = existing.locationBreakdown.find((entry) => entry.locationKey === location.locationKey) ??
                null;
            if (existingLocation) {
                existingLocation.eventCount += location.eventCount;
                existingLocation.inputTokens += location.inputTokens;
                existingLocation.cachedInputTokens += location.cachedInputTokens;
                existingLocation.outputTokens += location.outputTokens;
                existingLocation.reasoningOutputTokens += location.reasoningOutputTokens;
                existingLocation.totalTokens += location.totalTokens;
                existingLocation.hasInferredPricing ||= location.hasInferredPricing;
            }
            else {
                existing.locationBreakdown.push({ ...location });
            }
        }
        for (const model of session.modelBreakdown) {
            const existingModel = existing.modelBreakdown.find((entry) => entry.modelKey === model.modelKey) ?? null;
            if (existingModel) {
                existingModel.eventCount += model.eventCount;
                existingModel.inputTokens += model.inputTokens;
                existingModel.cachedInputTokens += model.cachedInputTokens;
                existingModel.outputTokens += model.outputTokens;
                existingModel.reasoningOutputTokens += model.reasoningOutputTokens;
                existingModel.totalTokens += model.totalTokens;
                existingModel.hasInferredPricing ||= model.hasInferredPricing;
            }
            else {
                existing.modelBreakdown.push({ ...model });
            }
        }
        for (const locationModel of session.locationModelBreakdown) {
            const existingLocationModel = existing.locationModelBreakdown.find((entry) => entry.locationKey === locationModel.locationKey &&
                entry.modelKey === locationModel.modelKey) ?? null;
            if (existingLocationModel) {
                existingLocationModel.eventCount += locationModel.eventCount;
                existingLocationModel.inputTokens += locationModel.inputTokens;
                existingLocationModel.cachedInputTokens += locationModel.cachedInputTokens;
                existingLocationModel.outputTokens += locationModel.outputTokens;
                existingLocationModel.reasoningOutputTokens += locationModel.reasoningOutputTokens;
                existingLocationModel.totalTokens += locationModel.totalTokens;
                existingLocationModel.hasInferredPricing ||= locationModel.hasInferredPricing;
            }
            else {
                existing.locationModelBreakdown.push({ ...locationModel });
            }
        }
    }
}
function mergeDailyAggregates(target, dailyAggregates) {
    for (const aggregate of dailyAggregates) {
        const key = [aggregate.day, aggregate.model ?? 'unknown', aggregate.projectKey].join('::');
        const existing = target.get(key);
        if (!existing) {
            target.set(key, { ...aggregate });
            continue;
        }
        existing.eventCount += aggregate.eventCount;
        existing.inputTokens += aggregate.inputTokens;
        existing.cachedInputTokens += aggregate.cachedInputTokens;
        existing.outputTokens += aggregate.outputTokens;
        existing.reasoningOutputTokens += aggregate.reasoningOutputTokens;
        existing.totalTokens += aggregate.totalTokens;
        existing.hasInferredPricing ||= aggregate.hasInferredPricing;
    }
}
export function parseCodexUsageRecord(line, context) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (!parsed.type || !parsed.payload) {
        return null;
    }
    if (parsed.type === 'session_meta') {
        context.sessionId = extractString(parsed.payload.id) ?? context.sessionId;
        context.sessionCwd = extractString(parsed.payload.cwd);
        if (!context.currentCwd && context.sessionCwd) {
            context.currentCwd = context.sessionCwd;
        }
        return null;
    }
    if (parsed.type === 'turn_context') {
        context.currentCwd =
            extractString(parsed.payload.cwd) ?? context.currentCwd ?? context.sessionCwd;
        context.currentModel = extractModel(parsed.payload) ?? context.currentModel;
        return null;
    }
    if (parsed.type !== 'event_msg' || parsed.payload.type !== 'token_count' || !parsed.timestamp) {
        return null;
    }
    const info = parsed.payload.info;
    if (info == null || typeof info !== 'object') {
        // Why: Codex emits token_count snapshots with null info for rate-limit
        // updates. Treating them as malformed usage would make active sessions look
        // flaky and create false scan errors for perfectly valid logs.
        return null;
    }
    const record = info;
    const totalUsage = normalizeRawUsage(record.total_token_usage);
    const lastUsage = normalizeRawUsage(record.last_token_usage);
    let delta = totalUsage ? subtractRawUsage(totalUsage, context.previousTotals) : lastUsage;
    if (totalUsage) {
        context.previousTotals = totalUsage;
    }
    if (!delta) {
        return null;
    }
    delta = {
        ...delta,
        cachedInputTokens: Math.min(delta.cachedInputTokens, delta.inputTokens)
    };
    if (delta.inputTokens === 0 &&
        delta.cachedInputTokens === 0 &&
        delta.outputTokens === 0 &&
        delta.reasoningOutputTokens === 0 &&
        delta.totalTokens === 0) {
        return null;
    }
    const resolvedModel = extractModel(parsed.payload) ?? context.currentModel;
    const model = resolvedModel ?? LEGACY_FALLBACK_MODEL;
    const hasInferredPricing = resolvedModel === null;
    return {
        sessionId: context.sessionId,
        timestamp: parsed.timestamp,
        cwd: context.currentCwd ?? context.sessionCwd,
        model,
        hasInferredPricing,
        inputTokens: delta.inputTokens,
        cachedInputTokens: delta.cachedInputTokens,
        outputTokens: delta.outputTokens,
        reasoningOutputTokens: delta.reasoningOutputTokens,
        totalTokens: delta.totalTokens
    };
}
export async function parseCodexUsageFile(filePath, worktrees) {
    const processedFile = await getProcessedFileInfo(filePath);
    const lines = createInterface({
        input: createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity
    });
    const events = [];
    const context = {
        sessionId: basename(filePath, '.jsonl'),
        sessionCwd: null,
        currentCwd: null,
        currentModel: null,
        previousTotals: null
    };
    for await (const line of lines) {
        const parsed = parseCodexUsageRecord(line, context);
        if (!parsed) {
            continue;
        }
        const attributed = await attributeCodexUsageEvent(parsed, worktrees);
        if (attributed) {
            events.push(attributed);
        }
    }
    return {
        ...processedFile,
        ...aggregateCodexUsage(events)
    };
}
export async function scanCodexUsageFiles(worktrees, previousProcessedFiles) {
    const files = await listCodexSessionFiles();
    const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]));
    const processedFiles = [];
    const worktreesWithCanonicalPaths = await buildWorktreesWithCanonicalPaths(worktrees);
    const sessionsById = new Map();
    const dailyByKey = new Map();
    for (const [index, filePath] of files.entries()) {
        const fileInfo = await getProcessedFileInfo(filePath);
        const previous = previousByPath.get(filePath);
        const canReuse = previous && previous.mtimeMs === fileInfo.mtimeMs && previous.size === fileInfo.size;
        const processed = canReuse
            ? previous
            : await parseCodexUsageFile(filePath, worktreesWithCanonicalPaths);
        processedFiles.push(processed);
        mergeSessions(sessionsById, processed.sessions);
        mergeDailyAggregates(dailyByKey, processed.dailyAggregates);
        // Why: Codex session history can grow large, and scans run on the Electron
        // main process. Yield regularly so opening Settings does not stall while
        // a background refresh walks old JSONL files.
        if ((index + 1) % YIELD_EVERY_FILES === 0) {
            await yieldToEventLoop();
        }
    }
    return {
        processedFiles,
        sessions: finalizeSessions(sessionsById),
        dailyAggregates: [...dailyByKey.values()].sort((left, right) => left.day === right.day
            ? left.projectLabel.localeCompare(right.projectLabel)
            : left.day.localeCompare(right.day))
    };
}
export function createWorktreeRefs(repos, worktreesByRepo) {
    const refs = [];
    for (const repo of repos) {
        for (const worktree of worktreesByRepo.get(repo.id) ?? []) {
            refs.push({
                repoId: repo.id,
                worktreeId: worktree.worktreeId,
                path: worktree.path,
                displayName: worktree.displayName
            });
        }
    }
    return refs;
}
export function getDefaultWorktreeLabel(pathValue) {
    return basename(pathValue);
}
export function getSessionProjectLabel(locationBreakdown) {
    if (locationBreakdown.length === 0) {
        return 'Unknown location';
    }
    if (locationBreakdown.length === 1) {
        return locationBreakdown[0].projectLabel;
    }
    return 'Multiple locations';
}
