import type { StatsCollector } from './collector';
/**
 * Per-PTY agent detection state machine.
 *
 * Lifecycle: UNKNOWN → AGENT → STOPPED
 *
 * - UNKNOWN: PTY just spawned, no OSC title seen yet.
 * - AGENT: OSC title detected as an agent. Tracks repeated working→idle
 *   cycles so one long-lived PTY can contribute multiple agent sessions.
 * - STOPPED: PTY exited. Emits agent_stop if a session is still open.
 *
 * Why we keep scanning OSC titles after classification: agent CLIs can stay in
 * one PTY for multiple prompts. If we stopped scanning after the first title,
 * a long-lived Claude/Codex session would collapse multiple work cycles into
 * one giant session and we would never emit the idle-time stop boundaries that
 * the stats design relies on.
 */
export declare class AgentDetector {
    private ptys;
    private stats;
    constructor(stats: StatsCollector);
    /**
     * Called on every PTY data chunk (from orca-runtime.ts onPtyData).
     * Receives raw data BEFORE normalization, since normalizeTerminalChunk
     * strips OSC sequences that we need for agent detection.
     */
    onData(ptyId: string, rawData: string, at: number): void;
    /**
     * Called when a PTY process exits (from orca-runtime.ts onPtyExit).
     */
    onExit(ptyId: string): void;
}
