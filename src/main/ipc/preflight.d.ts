export type PreflightStatus = {
    git: {
        installed: boolean;
    };
    gh: {
        installed: boolean;
        authenticated: boolean;
    };
};
/** @internal - tests need a clean preflight cache between cases. */
export declare function _resetPreflightCache(): void;
export declare function detectInstalledAgents(): Promise<string[]>;
export declare function runPreflightCheck(force?: boolean): Promise<PreflightStatus>;
export declare function registerPreflightHandlers(): void;
