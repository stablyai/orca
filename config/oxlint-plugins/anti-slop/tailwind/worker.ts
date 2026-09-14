import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { runAsWorker } from "synckit";

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

interface DesignSystem {
	canonicalizeCandidates(candidates: Array<string>, options: { rem: number }): Array<string>;
}

const designSystems = new Map<string, DesignSystem>();

runAsWorker(async (job: WorkerJob) => {
	if (job.type === "load") {
		designSystems.set(
			job.key,
			await __unstable__loadDesignSystem(job.cssContent, { base: job.base }) as DesignSystem,
		);
		return { ok: true };
	}

	const designSystem = designSystems.get(job.key);
	if (!designSystem) throw new Error(`Tailwind design system not loaded for "${job.key}"`);
	return designSystem.canonicalizeCandidates(job.candidates, { rem: job.rem });
});
