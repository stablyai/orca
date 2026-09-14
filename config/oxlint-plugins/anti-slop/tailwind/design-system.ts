import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncFn } from "synckit";

interface LoadJob {
	type: "load";
	key: string;
	cssContent: string;
	base: string;
}

interface CanonicalizeJob {
	type: "canonicalize";
	key: string;
	candidates: Array<string>;
	rem: number;
}

type WorkerJob = LoadJob | CanonicalizeJob;
type WorkerResult = { ok: true } | Array<string>;
type WorkerFunction = (job: WorkerJob) => Promise<WorkerResult>;

const workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url));
let syncCall: ReturnType<typeof createSyncFn<WorkerFunction>> | null = null;
const loadedSystems = new Map<string, number>();

function getSyncCall(): ReturnType<typeof createSyncFn<WorkerFunction>> {
	if (syncCall === null) {
		syncCall = createSyncFn<WorkerFunction>(workerPath);
	}
	return syncCall;
}

export function resolveCssPath(cssPath: string | undefined, cwd = process.cwd()): string {
	if (!cssPath) throw new Error("cssPath is required");
	return path.isAbsolute(cssPath) ? cssPath : path.resolve(cwd, cssPath);
}

export function ensureDesignSystem(cssFile: string): string {
	const stat = fs.statSync(cssFile);
	if (loadedSystems.get(cssFile) === stat.mtimeMs) return cssFile;

	const cssContent = fs.readFileSync(cssFile, "utf8");
	getSyncCall()({ type: "load", key: cssFile, cssContent, base: path.dirname(cssFile) });
	loadedSystems.set(cssFile, stat.mtimeMs);
	return cssFile;
}

export function canonicalizeTokens(key: string, tokens: Array<string>, rem: number): Map<string, string> {
	if (tokens.length === 0) return new Map();

	const canonical = getSyncCall()({ type: "canonicalize", key, candidates: tokens, rem });
	if (!Array.isArray(canonical)) throw new Error("Tailwind canonicalization returned an invalid result");

	const result = new Map<string, string>();
	for (let i = 0; i < tokens.length; i++) result.set(tokens[i], canonical[i] ?? tokens[i]);
	return result;
}
