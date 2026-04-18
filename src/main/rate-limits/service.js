import { fetchClaudeRateLimits } from './claude-fetcher';
import { fetchCodexRateLimits } from './codex-fetcher';
// Why: quota state does not need near-real-time polling, and a less aggressive
// default reduces avoidable Claude /usage pressure. We intentionally use a
// slower cadence here rather than polling every 2 minutes.
const DEFAULT_POLL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_REFETCH_MS = 30 * 1000; // 30 seconds — debounce rapid refresh requests
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes — after this, stale data is dropped
export class RateLimitService {
    state = { claude: null, codex: null };
    pollInterval = DEFAULT_POLL_MS;
    timer = null;
    lastFetchAt = 0;
    mainWindow = null;
    detachWindowListeners = null;
    isFetching = false;
    fullFetchQueued = false;
    codexOnlyFetchQueued = false;
    fetchIdleResolvers = [];
    codexFetchGeneration = 0;
    codexHomePathResolver = null;
    constructor() { }
    setCodexHomePathResolver(resolver) {
        this.codexHomePathResolver = resolver;
    }
    attach(mainWindow) {
        this.detachWindowListeners?.();
        this.mainWindow = mainWindow;
        const refreshOnResume = () => {
            void this.refreshIfWindowActive();
        };
        mainWindow.on('focus', refreshOnResume);
        mainWindow.on('show', refreshOnResume);
        mainWindow.on('restore', refreshOnResume);
        this.detachWindowListeners = () => {
            mainWindow.removeListener('focus', refreshOnResume);
            mainWindow.removeListener('show', refreshOnResume);
            mainWindow.removeListener('restore', refreshOnResume);
        };
        mainWindow.on('closed', () => {
            this.detachWindowListeners?.();
            this.detachWindowListeners = null;
            if (this.mainWindow === mainWindow) {
                this.mainWindow = null;
            }
        });
    }
    start() {
        // Fire initial fetch immediately on start
        void this.fetchAll();
        this.startTimer();
    }
    stop() {
        this.stopTimer();
        this.detachWindowListeners?.();
        this.detachWindowListeners = null;
        this.mainWindow = null;
    }
    getState() {
        return this.state;
    }
    async refresh() {
        // Why: the explicit refresh button is a user-directed recovery action.
        // Debouncing it behind the background poll throttle makes the UI feel
        // broken after wake/focus transitions because the click can no-op even
        // though the user is asking for a fresh read right now.
        await this.fetchAll({ force: true });
        return this.state;
    }
    async refreshForCodexAccountChange() {
        this.codexFetchGeneration += 1;
        // Why: switching the selected Codex account must immediately clear the old
        // Codex quota view. Keeping stale values visible would show the previous
        // account's limits under the newly selected identity until the next poll.
        this.updateState({
            ...this.state,
            codex: this.withFetchingStatus(null, 'codex')
        });
        await this.fetchCodexOnly({ force: true });
        return this.state;
    }
    setPollingInterval(ms) {
        this.pollInterval = Math.max(30_000, ms);
        if (this.timer) {
            this.stopTimer();
            this.startTimer();
        }
    }
    // ---------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------
    startTimer() {
        this.stopTimer();
        this.timer = setInterval(() => {
            if (!this.shouldBackgroundPoll()) {
                return;
            }
            void this.fetchAll();
        }, this.pollInterval);
    }
    stopTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    shouldBackgroundPoll() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            return false;
        }
        // Why: these quota fetches only power in-app UI. When Orca is hidden,
        // minimized, or unfocused, polling only burns CLI/API budget without any
        // visible benefit. We refresh again as soon as the window becomes active.
        if (!this.mainWindow.isVisible() || this.mainWindow.isMinimized()) {
            return false;
        }
        return this.mainWindow.isFocused();
    }
    async refreshIfWindowActive() {
        if (!this.shouldBackgroundPoll()) {
            return;
        }
        if (Date.now() - this.lastFetchAt < MIN_REFETCH_MS) {
            return;
        }
        await this.fetchAll();
    }
    async fetchAll(options) {
        if (this.isFetching) {
            if (options?.force) {
                this.fullFetchQueued = true;
                return this.waitForFetchIdle();
            }
            return;
        }
        this.isFetching = true;
        try {
            let shouldContinue = true;
            while (shouldContinue) {
                await this.runFetchAllCycle();
                shouldContinue = false;
                if (this.fullFetchQueued) {
                    this.fullFetchQueued = false;
                    shouldContinue = true;
                    continue;
                }
                if (this.codexOnlyFetchQueued) {
                    this.codexOnlyFetchQueued = false;
                    await this.runFetchCodexOnlyCycle();
                }
            }
        }
        finally {
            this.isFetching = false;
            this.resolveFetchIdleWaiters();
        }
    }
    async fetchCodexOnly(options) {
        if (this.isFetching) {
            if (options?.force) {
                this.codexOnlyFetchQueued = true;
                return this.waitForFetchIdle();
            }
            return;
        }
        this.isFetching = true;
        try {
            let shouldContinue = true;
            while (shouldContinue) {
                await this.runFetchCodexOnlyCycle();
                shouldContinue = false;
                if (this.fullFetchQueued) {
                    this.fullFetchQueued = false;
                    await this.runFetchAllCycle();
                    continue;
                }
                if (this.codexOnlyFetchQueued) {
                    this.codexOnlyFetchQueued = false;
                    shouldContinue = true;
                }
            }
        }
        finally {
            this.isFetching = false;
            this.resolveFetchIdleWaiters();
        }
    }
    waitForFetchIdle() {
        if (!this.isFetching && !this.fullFetchQueued && !this.codexOnlyFetchQueued) {
            return Promise.resolve();
        }
        // Why: explicit refresh callers need to await the queued follow-up cycle
        // when a poll is already in flight, otherwise the UI stops spinning before
        // the user-requested refresh actually runs.
        return new Promise((resolve) => {
            this.fetchIdleResolvers.push(resolve);
        });
    }
    resolveFetchIdleWaiters() {
        if (this.isFetching || this.fullFetchQueued || this.codexOnlyFetchQueued) {
            return;
        }
        const resolvers = this.fetchIdleResolvers;
        this.fetchIdleResolvers = [];
        for (const resolve of resolvers) {
            resolve();
        }
    }
    withFetchingStatus(current, provider) {
        if (!current) {
            return {
                provider,
                session: null,
                weekly: null,
                updatedAt: 0,
                error: null,
                status: 'fetching'
            };
        }
        return { ...current, status: 'fetching' };
    }
    async runFetchAllCycle() {
        const codexHomePath = this.codexHomePathResolver?.() ?? null;
        const codexProvenance = codexHomePath ? `managed:${codexHomePath}` : 'system';
        const codexGeneration = this.codexFetchGeneration;
        const previousState = this.state;
        // Mark both providers as fetching while keeping previous data visible.
        // Codex account changes clear Codex separately before this method is
        // called, so ordinary refreshes still preserve the current values.
        this.updateState({
            claude: this.withFetchingStatus(previousState.claude, 'claude'),
            codex: this.withFetchingStatus(previousState.codex, 'codex')
        });
        const [claude, codex] = await Promise.all([
            fetchClaudeRateLimits().catch((err) => ({
                provider: 'claude',
                session: null,
                weekly: null,
                updatedAt: Date.now(),
                error: err instanceof Error ? err.message : 'Unknown error',
                status: 'error'
            })),
            fetchCodexRateLimits({ codexHomePath }).catch((err) => ({
                provider: 'codex',
                session: null,
                weekly: null,
                updatedAt: Date.now(),
                error: err instanceof Error ? err.message : 'Unknown error',
                status: 'error'
            }))
        ]);
        const latestCodexHomePath = this.codexHomePathResolver?.() ?? null;
        const latestCodexProvenance = latestCodexHomePath ? `managed:${latestCodexHomePath}` : 'system';
        const shouldApplyCodex = codexGeneration === this.codexFetchGeneration && codexProvenance === latestCodexProvenance;
        // Why: account switches can race in-flight Codex fetches. Only apply a
        // Codex result if both the selected-account provenance and the request
        // generation still match, otherwise an old account could overwrite the
        // newly selected account's quota state.
        this.updateState({
            claude: this.applyStalePolicy(claude, previousState.claude),
            codex: shouldApplyCodex ? this.applyStalePolicy(codex, previousState.codex) : this.state.codex
        });
        this.lastFetchAt = Date.now();
    }
    async runFetchCodexOnlyCycle() {
        const codexHomePath = this.codexHomePathResolver?.() ?? null;
        const codexProvenance = codexHomePath ? `managed:${codexHomePath}` : 'system';
        const codexGeneration = this.codexFetchGeneration;
        const previousState = this.state;
        this.updateState({
            ...previousState,
            codex: this.withFetchingStatus(previousState.codex, 'codex')
        });
        const codex = await fetchCodexRateLimits({ codexHomePath }).catch((err) => ({
            provider: 'codex',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: err instanceof Error ? err.message : 'Unknown error',
            status: 'error'
        }));
        const latestCodexHomePath = this.codexHomePathResolver?.() ?? null;
        const latestCodexProvenance = latestCodexHomePath ? `managed:${latestCodexHomePath}` : 'system';
        const shouldApplyCodex = codexGeneration === this.codexFetchGeneration && codexProvenance === latestCodexProvenance;
        this.updateState({
            ...this.state,
            codex: shouldApplyCodex ? this.applyStalePolicy(codex, previousState.codex) : this.state.codex
        });
        this.lastFetchAt = Date.now();
    }
    applyStalePolicy(fresh, previous) {
        // Fresh data is fine — use it
        if (fresh.status === 'ok') {
            return fresh;
        }
        const previousHasData = Boolean(previous?.session || previous?.weekly);
        // No previous data to fall back on
        if (!previous || !previousHasData) {
            return fresh;
        }
        // Previous data is too old — don't show stale data
        if (Date.now() - previous.updatedAt > STALE_THRESHOLD_MS) {
            return fresh;
        }
        // Why: once we have a recent successful snapshot, repeated transient
        // failures should keep showing that same snapshot until it ages out of the
        // stale window. Otherwise the bar flaps from "stale but useful" to empty
        // after the second failure even though the last known quota is still fresh
        // enough to be actionable.
        return {
            ...previous,
            error: fresh.error,
            status: 'error'
        };
    }
    updateState(next) {
        this.state = next;
        this.pushToRenderer();
    }
    pushToRenderer() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            return;
        }
        this.mainWindow.webContents.send('rateLimits:update', this.state);
    }
}
