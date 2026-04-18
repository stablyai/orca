export type NudgeConfig = {
    id: string;
    minVersion?: string;
    maxVersion?: string;
};
export declare function fetchNudge(): Promise<NudgeConfig | null>;
export declare function versionMatchesRange(appVersion: string, range: {
    minVersion?: string;
    maxVersion?: string;
}): boolean;
export declare function shouldApplyNudge(args: {
    nudge: NudgeConfig;
    appVersion: string;
    pendingUpdateNudgeId: string | null;
    dismissedUpdateNudgeId: string | null;
}): boolean;
