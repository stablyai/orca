import type { ProviderRateLimits } from '../../shared/rate-limit-types';
export type FetchCodexRateLimitsOptions = {
    codexHomePath?: string | null;
};
export declare function fetchCodexRateLimits(options?: FetchCodexRateLimitsOptions): Promise<ProviderRateLimits>;
