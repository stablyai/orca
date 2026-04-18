import { describe, expect, it } from 'vitest';
import { compareVersions } from './updater-fallback';
describe('compareVersions', () => {
    it('compares prerelease and build semver strings correctly', () => {
        expect(compareVersions('1.0.70-rc.1', '1.0.69')).toBeGreaterThan(0);
        expect(compareVersions('1.0.70', '1.0.70-rc.1')).toBeGreaterThan(0);
        expect(compareVersions('1.0.70+build.5', '1.0.70')).toBe(0);
        expect(compareVersions('v1.0.70-beta.2', '1.0.70-beta.1')).toBeGreaterThan(0);
    });
});
