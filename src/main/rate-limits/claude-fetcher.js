import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fetchViaPty } from './claude-pty';
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const API_TIMEOUT_MS = 10_000;
/**
 * Read OAuth token from macOS Keychain.
 * Why: Claude Code v2.x+ stores OAuth credentials in the macOS Keychain
 * under service "Claude Code-credentials". This is the standard location
 * for Claude Max/Pro OAuth tokens. Only returns a token if the keychain
 * entry has a `claudeAiOauth.accessToken` — API key users won't have this.
 */
async function readFromKeychain() {
    if (process.platform !== 'darwin') {
        return null;
    }
    return new Promise((resolve) => {
        const user = process.env.USER ?? '';
        if (!user) {
            resolve(null);
            return;
        }
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-a', user, '-w'], { timeout: 3_000 }, (err, stdout) => {
            if (err || !stdout.trim()) {
                resolve(null);
                return;
            }
            try {
                const parsed = JSON.parse(stdout.trim());
                const token = parsed?.claudeAiOauth?.accessToken;
                if (!token || typeof token !== 'string') {
                    resolve(null);
                    return;
                }
                const expiresAt = parsed.claudeAiOauth?.expiresAt;
                if (typeof expiresAt === 'number' && expiresAt < Date.now()) {
                    resolve(null);
                    return;
                }
                resolve(token);
            }
            catch {
                resolve(null);
            }
        });
    });
}
/**
 * Read OAuth token from ~/.claude/.credentials.json (legacy path).
 * Why: older Claude CLI versions store credentials in this plain JSON
 * file. We keep it as a fallback for compatibility.
 */
async function readFromCredentialsFile() {
    const credPath = path.join(homedir(), '.claude', '.credentials.json');
    try {
        const raw = await readFile(credPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const token = parsed?.claudeAiOauth?.accessToken;
        if (!token || typeof token !== 'string') {
            return null;
        }
        const expiresAt = parsed.claudeAiOauth?.expiresAt;
        if (typeof expiresAt === 'number' && expiresAt < Date.now()) {
            return null;
        }
        return token;
    }
    catch {
        return null;
    }
}
/**
 * Try credential sources that yield a genuine OAuth bearer token.
 * Why: we intentionally do NOT read ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY
 * here — those are API keys which return 401 on the OAuth usage endpoint.
 * API-key users are served by the PTY fallback instead.
 */
async function readOAuthCredentials() {
    // 1. macOS Keychain (Claude Max/Pro OAuth)
    const fromKeychain = await readFromKeychain();
    if (fromKeychain) {
        return fromKeychain;
    }
    // 2. Legacy credentials file
    const fromFile = await readFromCredentialsFile();
    if (fromFile) {
        return fromFile;
    }
    return null;
}
function parseResetDescription(isoString) {
    if (!isoString) {
        return null;
    }
    try {
        const date = new Date(isoString);
        if (isNaN(date.getTime())) {
            return null;
        }
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        if (isToday) {
            return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        }
        return date.toLocaleDateString(undefined, {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
        });
    }
    catch {
        return null;
    }
}
function mapWindow(raw, windowMinutes) {
    if (!raw || typeof raw.utilization !== 'number') {
        return null;
    }
    return {
        usedPercent: Math.min(100, Math.max(0, raw.utilization)),
        windowMinutes,
        resetsAt: raw.resets_at ? new Date(raw.resets_at).getTime() || null : null,
        resetDescription: parseResetDescription(raw.resets_at)
    };
}
async function fetchViaOAuth(token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const res = await fetch(OAUTH_USAGE_URL, {
            headers: {
                Authorization: `Bearer ${token}`,
                'anthropic-beta': OAUTH_BETA_HEADER
            },
            signal: controller.signal
        });
        if (!res.ok) {
            throw new Error(`OAuth API returned ${res.status}`);
        }
        const data = (await res.json());
        return {
            provider: 'claude',
            session: mapWindow(data.five_hour, 300),
            weekly: mapWindow(data.seven_day, 10080),
            updatedAt: Date.now(),
            error: null,
            status: 'ok'
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function fetchClaudeRateLimits() {
    // Path A: try OAuth API if we have a genuine OAuth token
    const oauthToken = await readOAuthCredentials();
    if (oauthToken) {
        try {
            return await fetchViaOAuth(oauthToken);
        }
        catch {
            // OAuth API failed — fall through to PTY scraping as a backup
            // for subscription users whose token may still be valid for the CLI.
        }
        // Path B: PTY fallback — only for subscription plan users (Max/Pro)
        // whose OAuth token we found but the API call failed. The CLI's
        // `/usage` command is subscription-only, so there's no point
        // attempting PTY for API key users.
        try {
            return await fetchViaPty();
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            return {
                provider: 'claude',
                session: null,
                weekly: null,
                updatedAt: Date.now(),
                error: message,
                status: 'error'
            };
        }
    }
    // No OAuth token found — user authenticates via API key.
    // Why: plan usage limits (session/weekly) only exist for Claude Max/Pro
    // subscription plans. API key users are billed per-token and don't have
    // rate limit windows to display.
    return {
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'No subscription plan — API key billing',
        status: 'unavailable'
    };
}
