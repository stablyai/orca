import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.fn();
vi.mock('electron', () => ({
    net: { fetch: (...args) => fetchMock(...args) }
}));
import { fetchChangelog } from './updater-changelog';
function jsonResponse(body) {
    return { ok: true, json: () => Promise.resolve(body) };
}
function makeEntries(items) {
    return items.map((item) => ({
        version: item.version,
        title: item.title ?? `Release ${item.version}`,
        description: item.description ?? '',
        mediaUrl: item.mediaUrl,
        releaseNotesUrl: item.releaseNotesUrl ?? `https://onorca.dev/changelog/${item.version}`
    }));
}
describe('fetchChangelog', () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });
    it('returns exact match when the incoming version has rich content', async () => {
        const entries = makeEntries([
            {
                version: '1.1.21',
                description: 'New feature',
                mediaUrl: 'https://onorca.dev/media/1.1.21.gif'
            },
            { version: '1.1.20' },
            { version: '1.1.19' }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.21', '1.1.19');
        expect(result).not.toBeNull();
        expect(result.release.title).toBe('Release 1.1.21');
        expect(result.release.releaseNotesUrl).toBe('https://onorca.dev/changelog/1.1.21');
        expect(result.releasesBehind).toBe(2);
    });
    it('falls back to the most recent rich entry when incoming version is not in JSON', async () => {
        // Incoming 1.1.21 is not in JSON; 1.1.17 has rich content.
        // User is on 1.1.15 which is behind 1.1.17.
        const entries = makeEntries([
            {
                version: '1.1.17',
                description: 'Cool feature',
                mediaUrl: 'https://onorca.dev/media/1.1.17.gif',
                releaseNotesUrl: 'https://onorca.dev/changelog/1.1.17'
            },
            { version: '1.1.16' },
            { version: '1.1.15' }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.21', '1.1.15');
        expect(result).not.toBeNull();
        expect(result.release.title).toBe('Release 1.1.17');
        expect(result.release.description).toBe('Cool feature');
        // Why: fallback entries link to the generic changelog, not a version-specific page.
        expect(result.release.releaseNotesUrl).toBe('https://onorca.dev/changelog');
        expect(result.releasesBehind).toBe(2);
    });
    it('falls back when incoming version is in JSON but has no rich content', async () => {
        // Incoming 1.1.21 exists but has empty description and no media.
        // 1.1.17 has rich content.
        const entries = makeEntries([
            { version: '1.1.21', description: '', mediaUrl: undefined },
            {
                version: '1.1.17',
                description: 'Great update',
                mediaUrl: 'https://onorca.dev/media/1.1.17.gif'
            },
            { version: '1.1.15' }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.21', '1.1.15');
        expect(result).not.toBeNull();
        expect(result.release.title).toBe('Release 1.1.17');
        expect(result.release.releaseNotesUrl).toBe('https://onorca.dev/changelog');
        // releasesBehind is from local (index 2) to incoming (index 0) = 2
        expect(result.releasesBehind).toBe(2);
    });
    it('returns null when no entry has rich content', async () => {
        const entries = makeEntries([
            { version: '1.1.21', description: '' },
            { version: '1.1.20', description: '' },
            { version: '1.1.19', description: '' }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.21', '1.1.19');
        expect(result).toBeNull();
    });
    it('treats description-only entries (no media) as non-rich', async () => {
        // Exact match has a description but no mediaUrl — should not count as rich.
        const entries = makeEntries([
            { version: '1.1.21', description: 'Bug fixes and improvements' },
            { version: '1.1.20', description: 'Minor tweaks' },
            { version: '1.1.19' }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.21', '1.1.19');
        expect(result).toBeNull();
    });
    it('skips rich entries that the user has already passed', async () => {
        // User is on 1.1.18, which is ahead of the only rich entry (1.1.17).
        const entries = makeEntries([
            { version: '1.1.20', description: '' },
            { version: '1.1.18' },
            {
                version: '1.1.17',
                description: 'Old feature',
                mediaUrl: 'https://onorca.dev/media/old.gif'
            }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.20', '1.1.18');
        // 1.1.18 is at index 1, 1.1.17 is at index 2 — user is already past it.
        expect(result).toBeNull();
    });
    it('shows rich entry at the same version as localVersion', async () => {
        // User is on 1.1.18 which has rich content; incoming 1.1.20 has none.
        // The user may not have seen the rich card for 1.1.18 (e.g., they updated
        // silently), so showing it is better than showing nothing.
        const entries = makeEntries([
            { version: '1.1.20', description: '' },
            {
                version: '1.1.18',
                description: 'Current feature',
                mediaUrl: 'https://onorca.dev/media/current.gif'
            },
            { version: '1.1.17' }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.20', '1.1.18');
        expect(result).not.toBeNull();
        expect(result.release.title).toBe('Release 1.1.18');
        expect(result.release.releaseNotesUrl).toBe('https://onorca.dev/changelog');
    });
    it('shows rich entry when local version is not in JSON (very old user)', async () => {
        const entries = makeEntries([
            { version: '1.1.20', description: '' },
            {
                version: '1.1.17',
                description: 'Feature demo',
                mediaUrl: 'https://onorca.dev/media/demo.gif'
            }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.21', '1.0.0');
        expect(result).not.toBeNull();
        expect(result.release.title).toBe('Release 1.1.17');
        expect(result.release.releaseNotesUrl).toBe('https://onorca.dev/changelog');
        // releasesBehind is null because the local version isn't in the JSON.
        expect(result.releasesBehind).toBeNull();
    });
    it('skips rich entries when local version is newer than all changelog entries', async () => {
        // Local version 1.1.25 is not in the JSON and is newer than the latest
        // changelog entry (1.1.20). The rich entry at 1.1.17 is stale — the user
        // has already passed it.
        const entries = makeEntries([
            { version: '1.1.20', description: '' },
            {
                version: '1.1.17',
                description: 'Old feature',
                mediaUrl: 'https://onorca.dev/media/old.gif'
            }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.26', '1.1.25');
        expect(result).toBeNull();
    });
    it('returns null on non-ok HTTP response', async () => {
        fetchMock.mockResolvedValue({ ok: false });
        const result = await fetchChangelog('1.1.21', '1.1.19');
        expect(result).toBeNull();
    });
    it('returns null on non-array JSON', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ bad: true }));
        const result = await fetchChangelog('1.1.21', '1.1.19');
        expect(result).toBeNull();
    });
    it('prefers exact match over fallback when both have rich content', async () => {
        const entries = makeEntries([
            {
                version: '1.1.21',
                description: 'Latest feature',
                mediaUrl: 'https://onorca.dev/media/latest.gif'
            },
            {
                version: '1.1.17',
                description: 'Older feature',
                mediaUrl: 'https://onorca.dev/media/old.gif'
            },
            { version: '1.1.15' }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.21', '1.1.15');
        expect(result.release.title).toBe('Release 1.1.21');
        // Exact match keeps its own releaseNotesUrl.
        expect(result.release.releaseNotesUrl).toBe('https://onorca.dev/changelog/1.1.21');
    });
    it('strips version from the returned release object', async () => {
        const entries = makeEntries([
            { version: '1.1.17', description: 'Feature', mediaUrl: 'https://onorca.dev/media/demo.gif' },
            { version: '1.1.15' }
        ]);
        fetchMock.mockResolvedValue(jsonResponse(entries));
        const result = await fetchChangelog('1.1.21', '1.1.15');
        expect(result).not.toBeNull();
        expect('version' in result.release).toBe(false);
    });
});
