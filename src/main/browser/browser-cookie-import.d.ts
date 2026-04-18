import { type BrowserWindow } from 'electron';
import type { BrowserCookieImportResult, BrowserSessionProfileSource } from '../../shared/types';
export type BrowserProfile = {
    name: string;
    directory: string;
};
export type DetectedBrowser = {
    family: BrowserSessionProfileSource['browserFamily'];
    label: string;
    cookiesPath: string;
    keychainService?: string;
    keychainAccount?: string;
    profiles: BrowserProfile[];
    selectedProfile: string;
};
export declare function detectInstalledBrowsers(): DetectedBrowser[];
export declare function selectBrowserProfile(browser: DetectedBrowser, profileDirectory: string): DetectedBrowser | null;
export declare function pickCookieFile(parentWindow: BrowserWindow | null): Promise<string | null>;
export declare function importCookiesFromFile(filePath: string, targetPartition: string): Promise<BrowserCookieImportResult>;
export declare function importCookiesFromBrowser(browser: DetectedBrowser, targetPartition: string): Promise<BrowserCookieImportResult>;
