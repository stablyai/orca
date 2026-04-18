import type { Store } from '../persistence';
import type { OrcaRuntimeService } from '../runtime/orca-runtime';
import type { StatsCollector } from '../stats/collector';
import type { ClaudeUsageStore } from '../claude-usage/store';
import type { CodexUsageStore } from '../codex-usage/store';
import type { RateLimitService } from '../rate-limits/service';
import type { CodexAccountService } from '../codex-accounts/service';
export declare function registerCoreHandlers(store: Store, runtime: OrcaRuntimeService, stats: StatsCollector, claudeUsage: ClaudeUsageStore, codexUsage: CodexUsageStore, codexAccounts: CodexAccountService, rateLimits: RateLimitService, mainWindowWebContentsId?: number | null): void;
