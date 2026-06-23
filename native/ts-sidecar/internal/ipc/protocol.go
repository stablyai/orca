// Package ipc defines the NDJSON request/response/event protocol the desktop
// main process speaks to the tailnet sidecar over a unix socket (named pipe on
// Windows). It mirrors the daemon's framing so the TS client stays simple.
package ipc

// Version is the sidecar protocol version reported in the hello handshake.
// Bump on any breaking change to request/response shapes.
const Version = 1

// Request is one NDJSON line from the desktop to the sidecar.
type Request struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Token string `json:"token,omitempty"`
}

// Response is the reply to a Request, correlated by ID.
type Response struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Result any    `json:"result,omitempty"`
}

// Event is an unsolicited message (no ID) the sidecar pushes when tailnet state
// changes, so the desktop can update status without polling.
type Event struct {
	Type    string `json:"type"` // always "event"
	Event   string `json:"event"`
	Payload any    `json:"payload"`
}

// NodeState enumerates the coarse tailnet lifecycle states surfaced to the UI.
type NodeState string

const (
	StateStopped   NodeState = "Stopped"
	StateStarting  NodeState = "Starting"
	StateNeedsAuth NodeState = "NeedsLogin"
	StateRunning   NodeState = "Running"
)

// MapBackendState collapses tailscale's ipn.State strings into the coarse states
// the desktop UI cares about. Unknown states map to Stopped so the UI fails safe.
func MapBackendState(backendState string) NodeState {
	switch backendState {
	case "Running":
		return StateRunning
	case "NeedsLogin", "NeedsMachineAuth":
		return StateNeedsAuth
	case "Starting", "NoState":
		return StateStarting
	default:
		return StateStopped
	}
}

// StatusResult is the payload of a status response and of state events.
type StatusResult struct {
	State        NodeState `json:"state"`
	TailnetIP    string    `json:"tailnetIp,omitempty"`
	MagicDNSName string    `json:"magicDnsName,omitempty"`
	// AuthURL is set when the node needs interactive login; the desktop opens it.
	AuthURL string `json:"authUrl,omitempty"`
	// SocksPort is the loopback port of the outbound SOCKS5 proxy.
	SocksPort int `json:"socksPort,omitempty"`
}

func okResponse(id string, result any) Response {
	return Response{ID: id, OK: true, Result: result}
}

func errorResponse(id, msg string) Response {
	return Response{ID: id, OK: false, Error: msg}
}

// NewStateEvent builds the event the sidecar emits on every status change.
func NewStateEvent(status StatusResult) Event {
	return Event{Type: "event", Event: "state", Payload: status}
}
