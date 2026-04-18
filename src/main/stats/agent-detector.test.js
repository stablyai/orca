import { describe, expect, it, vi } from 'vitest';
import { AgentDetector } from './agent-detector';
function oscTitle(title) {
    return `\x1b]0;${title}\x07`;
}
describe('AgentDetector', () => {
    it('records a start when a PTY first identifies as an agent', () => {
        const stats = {
            onAgentStart: vi.fn(),
            onAgentStop: vi.fn()
        };
        const detector = new AgentDetector(stats);
        detector.onData('pty-1', oscTitle('✳ Claude Code'), 100);
        expect(stats.onAgentStart).toHaveBeenCalledWith('pty-1', 100);
        expect(stats.onAgentStop).not.toHaveBeenCalled();
    });
    it('stops a session on working to idle transition using the last meaningful output time', () => {
        const stats = {
            onAgentStart: vi.fn(),
            onAgentStop: vi.fn()
        };
        const detector = new AgentDetector(stats);
        detector.onData('pty-1', oscTitle('✳ Claude Code'), 100);
        detector.onData('pty-1', `${oscTitle('⠂ Writing patch')}real output`, 120);
        detector.onData('pty-1', '\x1b[2K', 130);
        detector.onData('pty-1', oscTitle('✳ Claude Code'), 140);
        expect(stats.onAgentStart).toHaveBeenCalledTimes(1);
        expect(stats.onAgentStop).toHaveBeenCalledTimes(1);
        expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120);
    });
    it('starts a new session when an idle agent becomes working again in the same PTY', () => {
        const stats = {
            onAgentStart: vi.fn(),
            onAgentStop: vi.fn()
        };
        const detector = new AgentDetector(stats);
        detector.onData('pty-1', oscTitle('✳ Claude Code'), 100);
        detector.onData('pty-1', `${oscTitle('⠂ First task')}first`, 120);
        detector.onData('pty-1', oscTitle('✳ Claude Code'), 140);
        detector.onData('pty-1', `${oscTitle('⠂ Second task')}second`, 200);
        expect(stats.onAgentStart).toHaveBeenCalledTimes(2);
        expect(stats.onAgentStart).toHaveBeenNthCalledWith(1, 'pty-1', 100);
        expect(stats.onAgentStart).toHaveBeenNthCalledWith(2, 'pty-1', 200);
        expect(stats.onAgentStop).toHaveBeenCalledTimes(1);
        expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120);
    });
    it('stops an active session on PTY exit', () => {
        const stats = {
            onAgentStart: vi.fn(),
            onAgentStop: vi.fn()
        };
        const detector = new AgentDetector(stats);
        detector.onData('pty-1', `${oscTitle('⠂ Writing patch')}real output`, 100);
        detector.onData('pty-1', 'more output', 120);
        detector.onExit('pty-1');
        expect(stats.onAgentStart).toHaveBeenCalledWith('pty-1', 100);
        expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120);
    });
});
