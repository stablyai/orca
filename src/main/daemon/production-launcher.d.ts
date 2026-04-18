import type { DaemonLauncher } from './daemon-spawner';
export type ProductionLauncherOptions = {
    getDaemonEntryPath: () => string;
};
export declare function createProductionLauncher(opts: ProductionLauncherOptions): DaemonLauncher;
