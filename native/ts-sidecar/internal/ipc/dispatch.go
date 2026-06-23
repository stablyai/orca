package ipc

import (
	"context"
	"crypto/subtle"
)

// Node is the tailnet capability surface the dispatcher drives. The tsnet-backed
// implementation lives in the imperative shell (main); tests use a fake. Keeping
// this interface free of tsnet types is what lets the dispatcher tests compile
// without the heavy tailscale dependency.
type Node interface {
	// Status reports the current tailnet state for a status request or event.
	Status() StatusResult
	// Up ensures the node is started and begins interactive login if required.
	Up(ctx context.Context) error
	// Down brings the node offline without discarding persisted node-key state.
	Down() error
}

// Dispatcher routes authenticated requests to a Node. It owns no I/O.
type Dispatcher struct {
	token string
	node  Node
}

func NewDispatcher(token string, node Node) *Dispatcher {
	return &Dispatcher{token: token, node: node}
}

// Handle validates the request token and dispatches by type. It is pure with
// respect to I/O: the only side effects are those the Node performs.
func (d *Dispatcher) Handle(ctx context.Context, req Request) Response {
	if subtle.ConstantTimeCompare([]byte(req.Token), []byte(d.token)) != 1 {
		return errorResponse(req.ID, "unauthorized")
	}

	switch req.Type {
	case "hello":
		return okResponse(req.ID, map[string]any{"version": Version})
	case "status":
		return okResponse(req.ID, d.node.Status())
	case "up":
		if err := d.node.Up(ctx); err != nil {
			return errorResponse(req.ID, err.Error())
		}
		return okResponse(req.ID, d.node.Status())
	case "down":
		if err := d.node.Down(); err != nil {
			return errorResponse(req.ID, err.Error())
		}
		return okResponse(req.ID, d.node.Status())
	default:
		return errorResponse(req.ID, "unknown request type: "+req.Type)
	}
}
