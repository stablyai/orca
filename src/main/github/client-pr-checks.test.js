import { beforeEach, describe, expect, it, vi } from 'vitest';
const { execFileAsyncMock, ghExecFileAsyncMock, getOwnerRepoMock, gitExecFileAsyncMock, acquireMock, releaseMock } = vi.hoisted(() => ({
    execFileAsyncMock: vi.fn(),
    ghExecFileAsyncMock: vi.fn(),
    getOwnerRepoMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    acquireMock: vi.fn(),
    releaseMock: vi.fn()
}));
vi.mock('./gh-utils', () => ({
    execFileAsync: execFileAsyncMock,
    ghExecFileAsync: ghExecFileAsyncMock,
    getOwnerRepo: getOwnerRepoMock,
    acquire: acquireMock,
    release: releaseMock,
    _resetOwnerRepoCache: vi.fn()
}));
vi.mock('../git/runner', () => ({
    gitExecFileAsync: gitExecFileAsyncMock
}));
import { getPRChecks, _resetOwnerRepoCache } from './client';
describe('getPRChecks', () => {
    beforeEach(() => {
        execFileAsyncMock.mockReset();
        ghExecFileAsyncMock.mockReset();
        getOwnerRepoMock.mockReset();
        gitExecFileAsyncMock.mockReset();
        acquireMock.mockReset();
        releaseMock.mockReset();
        acquireMock.mockResolvedValue(undefined);
        _resetOwnerRepoCache();
    });
    it('queries check-runs by PR head SHA when GitHub remote metadata is available', async () => {
        getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' });
        ghExecFileAsyncMock.mockResolvedValueOnce({
            stdout: JSON.stringify({
                check_runs: [
                    {
                        name: 'build',
                        status: 'completed',
                        conclusion: 'success',
                        html_url: 'https://github.com/acme/widgets/actions/runs/1',
                        details_url: null
                    }
                ]
            })
        });
        const checks = await getPRChecks('/repo-root', 42, 'head-oid');
        expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['api', '--cache', '60s', 'repos/acme/widgets/commits/head-oid/check-runs?per_page=100'], { cwd: '/repo-root' });
        expect(checks).toEqual([
            {
                name: 'build',
                status: 'completed',
                conclusion: 'success',
                url: 'https://github.com/acme/widgets/actions/runs/1'
            }
        ]);
    });
    it('falls back to gh pr checks when the cached head SHA no longer resolves', async () => {
        getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' });
        ghExecFileAsyncMock
            .mockRejectedValueOnce(new Error('gh: No commit found for SHA: stale-head (HTTP 422)'))
            .mockResolvedValueOnce({
            stdout: JSON.stringify([{ name: 'lint', state: 'PASS', link: 'https://example.com/lint' }])
        });
        const checks = await getPRChecks('/repo-root', 42, 'stale-head');
        expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['pr', 'checks', '42', '--json', 'name,state,link'], { cwd: '/repo-root' });
        expect(checks).toEqual([
            {
                name: 'lint',
                status: 'completed',
                conclusion: 'success',
                url: 'https://example.com/lint'
            }
        ]);
    });
});
