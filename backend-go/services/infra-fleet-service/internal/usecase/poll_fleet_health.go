package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// PollFleetHealth is the write side of the "30s-cadence poller"
// specs/backend-go/services/infra-fleet-service.md §8 calls for — never
// implemented before this pass (see this service's README "Known gaps"),
// which meant infra.fleet_health had zero rows for every dev server,
// forever, and DevServerReachability.IsReachable (the gate
// dispatchExecutorForRepo and friends use to route git ops to a dev server
// vs execute locally) always returned false — live-reproduced on
// b15.openledger.vn: a genuinely connected, live agent still couldn't be
// used for git dispatch because no sample ever existed for it to read.
//
// Scope cut from the full spec: this only measures reachability
// (DevServerAgentClient.Health — an agent-level handshake check, the same
// primitive IsDevServerConnected's sibling IsConnected peeks at without
// dialing) for every registered dev server, every poll. CPU/RAM/disk/
// latency stay at zero (a valid, honest "not measured yet" input per
// domain.NewDevServerHealth's own invariants — the SSH-exec-based resource
// sampler HasFleetHealthPort.GetFleetHealth's doc comment references is a
// separate, materially larger feature, not addressed here). §8's
// leader-election-per-target/distributed-lock requirement for horizontally
// scaled replicas is also not addressed — this deployment runs a single
// infra-fleet-service instance, and the spec itself flags multi-replica
// fan-out as "an open design question for the Go rewrite's implementation
// phase, not resolved by this doc" — every replica polling every target
// would only ever be a minor efficiency concern (redundant polls), never a
// correctness one, so it's a reasonable follow-on rather than a blocker
// here.
type PollFleetHealth struct {
	devServers FleetHealthPollerRepository
	writer     FleetHealthWriter
	outbox     OutboxWriter
	agent      DevServerAgentClient
	conns      ConnectionRepository
	sessions   TerminalSessionRepository
	logger     *slog.Logger
}

// outbox may be nil — see Execute's "alerting is best-effort" doc comment;
// a nil outbox just means the transition still gets logged, never enqueued
// (used by the few tests/composition paths with no eventbus configured).
// conns may also be nil — a poll with no ConnectionRepository configured
// simply skips the connections degraded/reestablish state machine below
// (BE-SOL-STORAGE-003 §2) and behaves exactly as it did before that state
// machine existed. sessions may also be nil — a poll with no
// TerminalSessionRepository configured simply skips closing
// terminal_sessions on the degraded -> closed edge (TASK-BE-STORAGE-010);
// it never affects the degraded/reestablish transitions themselves.
func NewPollFleetHealth(devServers FleetHealthPollerRepository, writer FleetHealthWriter, outbox OutboxWriter, agent DevServerAgentClient, conns ConnectionRepository, sessions TerminalSessionRepository, logger *slog.Logger) *PollFleetHealth {
	if logger == nil {
		logger = slog.Default()
	}
	return &PollFleetHealth{devServers: devServers, writer: writer, outbox: outbox, agent: agent, conns: conns, sessions: sessions, logger: logger}
}

// Execute polls every registered dev server once and persists its sample.
// A per-dev-server failure (Health erroring, or the write itself failing)
// is logged and skipped — one unreachable/misbehaving target must never
// stop the rest of the fleet from being polled in the same pass.
//
// Admin alerting on a reachable=true -> false transition is best-effort:
// the WARN log line is unconditional (visible via `docker logs` today,
// zero new infra — this is what live incidents this session were actually
// diagnosed from), the outbox enqueue is attempted alongside it but a
// failure there is only logged, never allowed to fail the poll. See
// domain.DevServerDisconnectedSubject's doc comment for why the outbox
// event carries no recipient user IDs yet.
func (uc *PollFleetHealth) Execute(ctx context.Context) error {
	devServers, err := uc.devServers.ListAllDevServers(ctx)
	if err != nil {
		return err
	}

	for _, ds := range devServers {
		reachable, err := uc.agent.Health(ctx, ds)
		if err != nil {
			uc.logger.WarnContext(ctx, "poll_fleet_health: health check failed, recording unreachable",
				slog.String("devServerId", ds.ID), slog.Any("error", err))
			reachable = false
		}

		// Read the previous sample BEFORE UpsertFleetHealth overwrites it —
		// this is the only way to see a true->false edge at all, since
		// UpsertFleetHealth is a plain upsert with no history. A read
		// failure (e.g. no sample exists yet for a brand-new dev server)
		// just disables the transition check for this one poll; it must
		// never block recording the current sample.
		previous, hadPrevious, err := uc.writer.GetDevServerHealth(ctx, ds.ID)
		if err != nil {
			uc.logger.WarnContext(ctx, "poll_fleet_health: reading previous sample failed, skipping transition check",
				slog.String("devServerId", ds.ID), slog.Any("error", err))
			hadPrevious = false
		}

		sample, err := domain.NewDevServerHealth(ds.ID, reachable, 0, 0, 0, 0)
		if err != nil {
			uc.logger.WarnContext(ctx, "poll_fleet_health: constructing sample failed, skipping",
				slog.String("devServerId", ds.ID), slog.Any("error", err))
			continue
		}

		if err := uc.writer.UpsertFleetHealth(ctx, sample); err != nil {
			uc.logger.WarnContext(ctx, "poll_fleet_health: persisting sample failed",
				slog.String("devServerId", ds.ID), slog.Any("error", err))
			continue
		}

		if hadPrevious && previous.Reachable && !sample.Reachable {
			uc.alertDevServerDisconnected(ctx, ds)
			uc.markConnectionDegraded(ctx, ds)
		}
		if hadPrevious && !previous.Reachable && sample.Reachable {
			uc.reestablishConnection(ctx, ds)
		}
	}

	return nil
}

// markConnectionDegraded transitions ds's active Connection (if any)
// established -> degraded via the domain state machine
// (BE-SOL-STORAGE-003 §2) — called on a reachable=true -> false edge, the
// same edge alertDevServerDisconnected already fires on. A connection that
// is already degraded/closed, or that doesn't exist, is left untouched
// (MarkDegraded's own guard handles the "wrong status" case; this is not an
// error, just nothing to do).
func (uc *PollFleetHealth) markConnectionDegraded(ctx context.Context, ds domain.DevServer) {
	if uc.conns == nil {
		return
	}
	conn, found, err := uc.conns.GetActiveByDevServer(ctx, ds.TenantID, ds.ID)
	if err != nil {
		uc.logger.WarnContext(ctx, "poll_fleet_health: looking up active connection failed, skipping degraded transition",
			slog.String("devServerId", ds.ID), slog.Any("error", err))
		return
	}
	if !found {
		return
	}
	if err := conn.MarkDegraded(time.Now()); err != nil {
		// Already degraded/closed — nothing to do, not an error worth logging
		// at WARN (this is the expected steady state for a still-down dev
		// server whose connection was already marked degraded on a prior poll).
		return
	}
	if err := uc.conns.UpdateStatus(ctx, ds.TenantID, conn); err != nil {
		uc.logger.WarnContext(ctx, "poll_fleet_health: persisting degraded connection status failed",
			slog.String("devServerId", ds.ID), slog.String("connectionId", conn.ID), slog.Any("error", err))
	}
}

// reestablishConnection transitions ds's active Connection (if any) back to
// established when the agent reconnects within its grace period — or, if
// the grace period already expired, closes it instead (BE-SOL-STORAGE-003
// §2's "degraded -> closed" edge). Either way this is a health-poll-driven
// transition, never an inline status assignment — see domain.Connection's
// MarkDegraded/Reestablish/CloseAfterGracePeriodExpiry doc comments.
func (uc *PollFleetHealth) reestablishConnection(ctx context.Context, ds domain.DevServer) {
	if uc.conns == nil {
		return
	}
	conn, found, err := uc.conns.GetActiveByDevServer(ctx, ds.TenantID, ds.ID)
	if err != nil {
		uc.logger.WarnContext(ctx, "poll_fleet_health: looking up active connection failed, skipping reestablish",
			slog.String("devServerId", ds.ID), slog.Any("error", err))
		return
	}
	if !found || conn.Status != domain.ConnectionStatusDegraded {
		return
	}

	now := time.Now()
	transitionedToClosed := false
	if err := conn.Reestablish(now); err != nil {
		if !errors.Is(err, domain.ErrGracePeriodExpired) {
			uc.logger.WarnContext(ctx, "poll_fleet_health: reestablish failed",
				slog.String("devServerId", ds.ID), slog.String("connectionId", conn.ID), slog.Any("error", err))
			return
		}
		// Grace period already expired before the agent came back — this is
		// a real failure, not a transient blip; close it instead (§2's
		// "degraded -> closed" edge). See BE-SOL-STORAGE-003 §4: a caller
		// observing this closed transition is what should trigger
		// FailDispatch downstream, not the earlier degraded transition.
		if closeErr := conn.CloseAfterGracePeriodExpiry(now); closeErr != nil {
			uc.logger.WarnContext(ctx, "poll_fleet_health: closing connection after grace period expiry failed",
				slog.String("devServerId", ds.ID), slog.String("connectionId", conn.ID), slog.Any("error", closeErr))
			return
		}
		transitionedToClosed = true
	}
	if err := uc.conns.UpdateStatus(ctx, ds.TenantID, conn); err != nil {
		uc.logger.WarnContext(ctx, "poll_fleet_health: persisting reestablished/closed connection status failed",
			slog.String("devServerId", ds.ID), slog.String("connectionId", conn.ID), slog.Any("error", err))
		return
	}
	// Only close terminal_sessions once the connection has genuinely
	// transitioned to closed (grace period truly expired) — NOT on the
	// earlier degraded transition (markConnectionDegraded never calls this),
	// per BE-SOL-STORAGE-003 §3/TASK-BE-STORAGE-010.
	if transitionedToClosed {
		uc.closeTerminalSessions(ctx, ds, conn)
	}
}

// closeTerminalSessions closes every terminal_sessions row bound to conn's
// ID — called ONLY after conn has genuinely transitioned to closed
// (CloseAfterGracePeriodExpiry), never on a merely degraded connection.
// uc.sessions may be nil (no TerminalSessionRepository wired), in which case
// this is a no-op, same nil-safety convention as uc.conns.
func (uc *PollFleetHealth) closeTerminalSessions(ctx context.Context, ds domain.DevServer, conn domain.Connection) {
	if uc.sessions == nil {
		return
	}
	if err := NewCloseTerminalSessionsForConnection(uc.sessions).Execute(ctx, ds.TenantID, conn.ID); err != nil {
		uc.logger.WarnContext(ctx, "poll_fleet_health: closing terminal sessions for connection failed",
			slog.String("devServerId", ds.ID), slog.String("connectionId", conn.ID), slog.Any("error", err))
	}
}

// alertDevServerDisconnected fires exactly once per true->false edge (never
// on repeated false samples — Execute only calls this when the PREVIOUS
// sample was reachable) — a dev server down for an hour alerts once, not
// every 30s.
func (uc *PollFleetHealth) alertDevServerDisconnected(ctx context.Context, ds domain.DevServer) {
	uc.logger.WarnContext(ctx, "dev server disconnected",
		slog.String("devServerId", ds.ID), slog.String("host", ds.Host), slog.String("tenantId", ds.TenantID))

	if uc.outbox == nil {
		return
	}
	payload, err := json.Marshal(domain.DevServerDisconnectedPayload{
		DevServerID: ds.ID, Host: ds.Host, TenantID: ds.TenantID,
	})
	if err != nil {
		uc.logger.WarnContext(ctx, "poll_fleet_health: marshaling disconnect alert payload failed",
			slog.String("devServerId", ds.ID), slog.Any("error", err))
		return
	}
	event := domain.OutboxEvent{
		ID:          uuid.NewString(),
		TenantID:    ds.TenantID,
		Subject:     domain.DevServerDisconnectedSubject,
		OccurredAt:  time.Now().UTC(),
		PayloadJSON: payload,
	}
	if err := uc.outbox.InsertOutboxEvent(ctx, event); err != nil {
		uc.logger.WarnContext(ctx, "poll_fleet_health: enqueuing disconnect alert failed",
			slog.String("devServerId", ds.ID), slog.Any("error", err))
	}
}
