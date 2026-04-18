/* eslint-disable max-lines -- Why: this store is the single main-process owner for Claude usage persistence, scan gating, and query semantics. Keeping those policy decisions together avoids split-brain range/scope logic across multiple files. */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { listRepoWorktrees } from '../repo-worktrees';
import { mergeWorktree } from '../ipc/worktree-logic';
import { createWorktreeRefs, getDefaultWorktreeLabel, getSessionProjectLabel, scanClaudeUsageFiles } from './scanner';
const SCHEMA_VERSION = 1;
const STALE_MS = 5 * 60_000;
// Why: capture the path after configureDevUserDataPath() but before app.setName()
// mutates Electron's derived userData location, matching the persistence/store pattern.
let _claudeUsageFile = null;
const MODEL_PRICING = {
    'claude-opus-4-6': { input: 6.15, output: 30.75, cacheRead: 0.61, cacheWrite: 7.69 },
    'claude-opus-4-5': { input: 6.15, output: 30.75, cacheRead: 0.61, cacheWrite: 7.69 },
    'claude-sonnet-4-6': { input: 3.69, output: 18.45, cacheRead: 0.37, cacheWrite: 4.61 },
    'claude-sonnet-4-5': { input: 3.69, output: 18.45, cacheRead: 0.37, cacheWrite: 4.61 },
    'claude-haiku-4-5': { input: 1.23, output: 6.15, cacheRead: 0.12, cacheWrite: 1.54 }
};
function getDefaultState() {
    return {
        schemaVersion: SCHEMA_VERSION,
        processedFiles: [],
        sessions: [],
        dailyAggregates: [],
        scanState: {
            enabled: false,
            lastScanStartedAt: null,
            lastScanCompletedAt: null,
            lastScanError: null
        }
    };
}
export function initClaudeUsagePath() {
    _claudeUsageFile = join(app.getPath('userData'), 'orca-claude-usage.json');
}
function getClaudeUsageFile() {
    if (!_claudeUsageFile) {
        _claudeUsageFile = join(app.getPath('userData'), 'orca-claude-usage.json');
    }
    return _claudeUsageFile;
}
function normalizeModelForPricing(model) {
    if (!model) {
        return null;
    }
    const lower = model.toLowerCase();
    if (lower.includes('opus')) {
        return 'claude-opus-4-6';
    }
    if (lower.includes('sonnet')) {
        return 'claude-sonnet-4-6';
    }
    if (lower.includes('haiku')) {
        return 'claude-haiku-4-5';
    }
    return null;
}
function estimateCostUsd(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
    const normalized = normalizeModelForPricing(model);
    if (!normalized) {
        return null;
    }
    const pricing = MODEL_PRICING[normalized];
    return ((inputTokens * pricing.input +
        outputTokens * pricing.output +
        cacheReadTokens * pricing.cacheRead +
        cacheWriteTokens * pricing.cacheWrite) /
        1_000_000);
}
function getRangeCutoff(range) {
    if (range === 'all') {
        return null;
    }
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    now.setDate(now.getDate() - (days - 1));
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function getLocalDay(timestamp) {
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
export class ClaudeUsageStore {
    state;
    store;
    scanPromise = null;
    constructor(store) {
        this.store = store;
        this.state = this.load();
    }
    load() {
        try {
            const usageFile = getClaudeUsageFile();
            if (!existsSync(usageFile)) {
                return getDefaultState();
            }
            const parsed = JSON.parse(readFileSync(usageFile, 'utf-8'));
            return {
                ...getDefaultState(),
                ...parsed,
                scanState: {
                    ...getDefaultState().scanState,
                    ...parsed.scanState
                }
            };
        }
        catch (error) {
            // Why: Claude usage is a local analytics feature, not primary workspace
            // state. A corrupt cache should degrade to a fresh rebuild instead of
            // preventing Orca from booting, but we leave the file on disk for debugging.
            console.error('[claude-usage] Failed to load persisted state, starting fresh:', error);
            return getDefaultState();
        }
    }
    writeToDisk() {
        const usageFile = getClaudeUsageFile();
        const dir = dirname(usageFile);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        // Why: scans can refresh while the app is in active use. Use the same
        // atomic temp-file pattern as the main store so a crash or concurrent write
        // cannot leave a truncated analytics file as the common failure mode.
        const tmpFile = `${usageFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8');
        renameSync(tmpFile, usageFile);
    }
    async setEnabled(enabled) {
        this.state.scanState.enabled = enabled;
        this.writeToDisk();
        return this.getScanState();
    }
    getScanState() {
        return {
            ...this.state.scanState,
            isScanning: this.scanPromise !== null,
            hasAnyClaudeData: this.state.sessions.length > 0 || this.state.dailyAggregates.length > 0
        };
    }
    async refresh(force = false) {
        if (!this.state.scanState.enabled) {
            return this.getScanState();
        }
        if (!force && this.state.scanState.lastScanCompletedAt) {
            const ageMs = Date.now() - this.state.scanState.lastScanCompletedAt;
            if (ageMs < STALE_MS) {
                return this.getScanState();
            }
        }
        await this.runScan();
        return this.getScanState();
    }
    async runScan() {
        if (this.scanPromise) {
            await this.scanPromise;
            return;
        }
        this.state.scanState.lastScanStartedAt = Date.now();
        this.state.scanState.lastScanError = null;
        this.writeToDisk();
        this.scanPromise = (async () => {
            try {
                const repos = this.store.getRepos();
                const worktreesByRepo = await this.loadWorktreesByRepo(repos);
                const result = await scanClaudeUsageFiles(createWorktreeRefs(repos, worktreesByRepo));
                this.state.processedFiles = result.processedFiles;
                this.state.sessions = result.sessions;
                this.state.dailyAggregates = result.dailyAggregates;
                this.state.scanState.lastScanCompletedAt = Date.now();
                this.state.scanState.lastScanError = null;
                this.writeToDisk();
            }
            catch (error) {
                this.state.scanState.lastScanError = error instanceof Error ? error.message : String(error);
                this.writeToDisk();
            }
            finally {
                this.scanPromise = null;
            }
        })();
        await this.scanPromise;
    }
    async getSummary(scope, range) {
        await this.refresh(false);
        const filteredDaily = this.getFilteredDaily(scope, range);
        const filteredSessions = this.getFilteredSessions(scope, range);
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let turns = 0;
        let zeroCacheReadTurns = 0;
        const byModel = new Map();
        const byProject = new Map();
        let estimatedCostUsd = 0;
        let hasAnyBillableCost = false;
        for (const row of filteredDaily) {
            inputTokens += row.inputTokens;
            outputTokens += row.outputTokens;
            cacheReadTokens += row.cacheReadTokens;
            cacheWriteTokens += row.cacheWriteTokens;
            turns += row.turnCount;
            zeroCacheReadTurns += row.zeroCacheReadTurnCount;
            const modelKey = row.model ?? 'Unknown model';
            byModel.set(modelKey, (byModel.get(modelKey) ?? 0) + row.inputTokens + row.outputTokens);
            byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.inputTokens + row.outputTokens);
            const cost = estimateCostUsd(row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens);
            if (cost !== null) {
                hasAnyBillableCost = true;
                estimatedCostUsd += cost;
            }
        }
        const topModel = [...byModel.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
        const topProject = [...byProject.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
        return {
            scope,
            range,
            sessions: filteredSessions.length,
            turns,
            zeroCacheReadTurns,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            cacheReuseRate: inputTokens + cacheReadTokens > 0
                ? cacheReadTokens / (inputTokens + cacheReadTokens)
                : null,
            estimatedCostUsd: hasAnyBillableCost ? estimatedCostUsd : null,
            topModel,
            topProject,
            // Why: the empty-state UX is scope/range specific. Using global persisted
            // data here makes the Orca-only view render empty charts instead of the
            // intended "no usage for this scope" message when only off-Orca logs exist.
            hasAnyClaudeData: filteredSessions.length > 0 || filteredDaily.length > 0
        };
    }
    async getDaily(scope, range) {
        await this.refresh(false);
        const byDay = new Map();
        for (const row of this.getFilteredDaily(scope, range)) {
            const existing = byDay.get(row.day) ?? {
                day: row.day,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0
            };
            existing.inputTokens += row.inputTokens;
            existing.outputTokens += row.outputTokens;
            existing.cacheReadTokens += row.cacheReadTokens;
            existing.cacheWriteTokens += row.cacheWriteTokens;
            byDay.set(row.day, existing);
        }
        return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
    }
    async getBreakdown(scope, range, kind) {
        await this.refresh(false);
        const rows = new Map();
        const filteredDaily = this.getFilteredDaily(scope, range);
        const filteredSessions = this.getFilteredSessions(scope, range);
        for (const daily of filteredDaily) {
            const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey;
            const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel;
            const existing = rows.get(key) ?? {
                key,
                label,
                sessions: 0,
                turns: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                estimatedCostUsd: null
            };
            existing.turns += daily.turnCount;
            existing.inputTokens += daily.inputTokens;
            existing.outputTokens += daily.outputTokens;
            existing.cacheReadTokens += daily.cacheReadTokens;
            existing.cacheWriteTokens += daily.cacheWriteTokens;
            rows.set(key, existing);
        }
        for (const session of filteredSessions) {
            if (kind === 'model') {
                const key = session.model ?? 'unknown';
                const row = rows.get(key);
                if (row) {
                    row.sessions++;
                }
                continue;
            }
            const matchingLocations = session.locationBreakdown.filter((entry) => scope === 'all' ? true : entry.worktreeId !== null);
            const seen = new Set();
            for (const location of matchingLocations) {
                if (seen.has(location.locationKey)) {
                    continue;
                }
                seen.add(location.locationKey);
                const row = rows.get(location.locationKey);
                if (row) {
                    row.sessions++;
                }
            }
        }
        for (const row of rows.values()) {
            if (kind === 'model') {
                row.estimatedCostUsd = estimateCostUsd(row.key, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens);
            }
        }
        return [...rows.values()].sort((left, right) => {
            const leftTotal = left.inputTokens + left.outputTokens;
            const rightTotal = right.inputTokens + right.outputTokens;
            return rightTotal - leftTotal;
        });
    }
    async getRecentSessions(scope, range, limit = 12) {
        await this.refresh(false);
        return this.getFilteredSessions(scope, range)
            .slice(0, limit)
            .map((session) => {
            const matchingLocations = session.locationBreakdown.filter((entry) => scope === 'all' ? true : entry.worktreeId !== null);
            const scopedLocations = matchingLocations.length > 0 ? matchingLocations : session.locationBreakdown;
            const totals = scopedLocations.reduce((acc, entry) => {
                acc.turns += entry.turnCount;
                acc.inputTokens += entry.inputTokens;
                acc.outputTokens += entry.outputTokens;
                acc.cacheReadTokens += entry.cacheReadTokens;
                acc.cacheWriteTokens += entry.cacheWriteTokens;
                return acc;
            }, {
                turns: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0
            });
            const durationMinutes = Math.max(0, Math.round((new Date(session.lastTimestamp).getTime() -
                new Date(session.firstTimestamp).getTime()) /
                60_000));
            return {
                sessionId: session.sessionId,
                lastActiveAt: session.lastTimestamp,
                durationMinutes,
                projectLabel: getSessionProjectLabel(scopedLocations),
                branch: session.lastGitBranch,
                model: session.model,
                turns: totals.turns,
                inputTokens: totals.inputTokens,
                outputTokens: totals.outputTokens,
                cacheReadTokens: totals.cacheReadTokens,
                cacheWriteTokens: totals.cacheWriteTokens
            };
        });
    }
    getFilteredDaily(scope, range) {
        const cutoff = getRangeCutoff(range);
        return this.state.dailyAggregates.filter((entry) => {
            if (cutoff && entry.day < cutoff) {
                return false;
            }
            if (scope === 'orca' && entry.worktreeId === null) {
                return false;
            }
            return true;
        });
    }
    getFilteredSessions(scope, range) {
        const cutoff = getRangeCutoff(range);
        return this.state.sessions.filter((session) => {
            // Why: daily aggregates use local calendar days, so session filtering has
            // to use the same conversion or the sessions table/counts can disagree
            // with the chart around UTC day boundaries.
            const day = getLocalDay(session.lastTimestamp);
            if (!day) {
                return false;
            }
            if (cutoff && day < cutoff) {
                return false;
            }
            if (scope === 'orca') {
                return session.locationBreakdown.some((entry) => entry.worktreeId !== null);
            }
            return true;
        });
    }
    async loadWorktreesByRepo(repos) {
        const worktreesByRepo = new Map();
        for (const repo of repos) {
            const gitWorktrees = await listRepoWorktrees(repo);
            const mapped = gitWorktrees.map((worktree) => {
                const worktreeId = `${repo.id}::${worktree.path}`;
                const meta = this.store.getWorktreeMeta(worktreeId);
                const merged = mergeWorktree(repo.id, worktree, meta, repo.displayName);
                return {
                    worktreeId,
                    path: worktree.path,
                    displayName: merged.displayName || getDefaultWorktreeLabel(worktree.path)
                };
            });
            worktreesByRepo.set(repo.id, mapped);
        }
        return worktreesByRepo;
    }
}
