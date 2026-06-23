package ipc

import (
	"context"
	"errors"
	"testing"
)

// fakeNode is a controllable Node for dispatcher tests.
type fakeNode struct {
	status  StatusResult
	upErr   error
	downErr error
	upCalls int
	downHit bool
}

func (f *fakeNode) Status() StatusResult { return f.status }
func (f *fakeNode) Up(context.Context) error {
	f.upCalls++
	return f.upErr
}
func (f *fakeNode) Down() error {
	f.downHit = true
	return f.downErr
}

const testToken = "s3cr3t-token"

func handle(t *testing.T, node Node, req Request) Response {
	t.Helper()
	return NewDispatcher(testToken, node).Handle(context.Background(), req)
}

func TestHandleRejectsBadToken(t *testing.T) {
	node := &fakeNode{}
	resp := handle(t, node, Request{ID: "1", Type: "status", Token: "wrong"})
	if resp.OK {
		t.Fatalf("expected unauthorized, got ok response")
	}
	if resp.Error != "unauthorized" {
		t.Fatalf("error = %q, want unauthorized", resp.Error)
	}
	if resp.ID != "1" {
		t.Fatalf("response ID = %q, want 1", resp.ID)
	}
}

func TestHandleRejectsMissingToken(t *testing.T) {
	resp := handle(t, &fakeNode{}, Request{ID: "1", Type: "status"})
	if resp.OK || resp.Error != "unauthorized" {
		t.Fatalf("missing token should be unauthorized, got %+v", resp)
	}
}

func TestHandleHello(t *testing.T) {
	resp := handle(t, &fakeNode{}, Request{ID: "h", Type: "hello", Token: testToken})
	if !resp.OK {
		t.Fatalf("hello not ok: %+v", resp)
	}
	result, ok := resp.Result.(map[string]any)
	if !ok {
		t.Fatalf("hello result type = %T", resp.Result)
	}
	if result["version"] != Version {
		t.Fatalf("hello version = %v, want %d", result["version"], Version)
	}
}

func TestHandleStatusReturnsNodeStatus(t *testing.T) {
	node := &fakeNode{status: StatusResult{
		State:        StateRunning,
		TailnetIP:    "100.64.0.1",
		MagicDNSName: "desktop.tail.ts.net",
		SocksPort:    1055,
	}}
	resp := handle(t, node, Request{ID: "s", Type: "status", Token: testToken})
	if !resp.OK {
		t.Fatalf("status not ok: %+v", resp)
	}
	got, ok := resp.Result.(StatusResult)
	if !ok {
		t.Fatalf("status result type = %T", resp.Result)
	}
	if got.State != StateRunning || got.SocksPort != 1055 || got.TailnetIP != "100.64.0.1" {
		t.Fatalf("status mismatch: %+v", got)
	}
}

func TestHandleUpInvokesNodeAndReturnsStatus(t *testing.T) {
	node := &fakeNode{status: StatusResult{State: StateNeedsAuth, AuthURL: "https://login.tailscale.com/a/abc"}}
	resp := handle(t, node, Request{ID: "u", Type: "up", Token: testToken})
	if !resp.OK {
		t.Fatalf("up not ok: %+v", resp)
	}
	if node.upCalls != 1 {
		t.Fatalf("Up called %d times, want 1", node.upCalls)
	}
	got := resp.Result.(StatusResult)
	if got.AuthURL == "" {
		t.Fatalf("expected auth URL surfaced after up, got %+v", got)
	}
}

func TestHandleUpPropagatesError(t *testing.T) {
	node := &fakeNode{upErr: errors.New("control unreachable")}
	resp := handle(t, node, Request{ID: "u", Type: "up", Token: testToken})
	if resp.OK {
		t.Fatalf("expected up failure, got ok")
	}
	if resp.Error != "control unreachable" {
		t.Fatalf("error = %q, want control unreachable", resp.Error)
	}
}

func TestHandleDownInvokesNode(t *testing.T) {
	node := &fakeNode{}
	resp := handle(t, node, Request{ID: "d", Type: "down", Token: testToken})
	if !resp.OK || !node.downHit {
		t.Fatalf("down not handled: ok=%v hit=%v", resp.OK, node.downHit)
	}
}

func TestHandleUnknownType(t *testing.T) {
	resp := handle(t, &fakeNode{}, Request{ID: "x", Type: "frobnicate", Token: testToken})
	if resp.OK {
		t.Fatalf("expected error for unknown type")
	}
	if resp.Error != "unknown request type: frobnicate" {
		t.Fatalf("error = %q", resp.Error)
	}
}
